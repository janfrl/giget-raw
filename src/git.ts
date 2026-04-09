import { spawn } from "node:child_process";
import { mkdtemp, rm as rmAsync, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { resolve } from "pathe";
import type { TemplateProvider, TarOutput } from "./types.ts";
import { debug } from "./_utils.ts";

export const git: TemplateProvider = (input, options) => {
  const parsed = parseGitCloneURI(input);

  // Include subdir and files in version so the cache key is unique
  let version = parsed.version || "default";
  if (parsed.subdir || (options.files && options.files.length > 0)) {
    const hash = createHash("sha256");
    if (parsed.subdir) {
      hash.update(parsed.subdir);
    }
    if (options.files && options.files.length > 0) {
      hash.update(options.files.join(","));
    }
    version = `${version}-${hash.digest("hex").slice(0, 8)}`;
  }

  return {
    name: parsed.name,
    version,
    // subdir is handled during clone (sparse checkout) and tar creation,
    // so we don't set it here to avoid double-filtering during extraction
    tar: ({ auth } = {}) => _cloneAndTar(parsed, auth ?? options.auth, options.files),
  };
};

export function parseGitCloneURI(input: string, opts: { cwd?: string } = {}) {
  const cwd = opts.cwd ?? process.cwd();

  let uri = input.replace(/#.*$/, "");
  let pathSubdir: string | undefined;

  if (/^[./]/.test(input)) {
    // Local URI starts with . (relative) or / (absolute).
    // We return the absolute path for the provided URI.

    uri = resolve(cwd, uri);
  } else if (/^https?:\/\//.test(uri)) {
    // Git over HTTP(S) starts with http[s]://.
    // For known hosts, extract org/repo and treat the rest as subdir.
    const httpMatch = /^(https?:\/\/[^/]+)\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/(.+))?$/.exec(uri);
    if (httpMatch) {
      const [, origin, repo, rest] = httpMatch;
      uri = `${origin}/${repo}`;
      if (rest) {
        pathSubdir = rest;
      }
    }
  } else if (uri.includes("@")) {
    // Explicit SSH URI (e.g. git@github.com:org/repo)
    const sshMatch = /^(.*?:[\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/(.+))?$/.exec(uri);
    if (sshMatch) {
      const [, repoUri, rest] = sshMatch;
      uri = repoUri!;
      if (rest) {
        pathSubdir = rest;
      }
    }
  } else {
    // Default: resolve to HTTPS URL
    const hostMap: Record<string, string> = {
      "github:": "https://github.com/",
      "gh:": "https://github.com/",
      "gitlab:": "https://gitlab.com/",
      "bitbucket:": "https://bitbucket.org/",
      "sourcehut:": "https://git.sr.ht/~",
    };

    const host = /^(.+?:)/.exec(uri)?.at(1);
    if (host && hostMap[host]) {
      uri = uri.replace(host, hostMap[host]);
    } else if (!host) {
      const defaultHost = process.env.GIGET_GIT_HOST || "https://github.com/";
      uri = `${defaultHost.replace(/\/$/, "")}/${uri}`;
    }

    // Extract org/repo and treat extra path segments as subdir
    const httpMatch = /^(https?:\/\/[^/]+\/~?[\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/(.+))?$/.exec(uri);
    if (httpMatch) {
      const [, repoUri, rest] = httpMatch;
      uri = repoUri!;
      if (rest) {
        pathSubdir = rest;
      }
    }
  }

  const name = uri
    .replace(/^https?:\/\//, "")
    // Remove username-password segment
    .replace(/^.+@/, "")
    // Remove trailing git and hash
    .replace(/(\.git)?(#.*)?$/, "")
    // Remove non-words before name
    .replace(/^\W+/, "")
    // Replace special characters with -
    .replaceAll(/[:/]/g, "-");

  const [version, hashSubdir] = /#(.+)$/.exec(input)?.at(1)?.split(":") ?? [];
  // For `#:subdir` syntax, version is "" (empty) — normalize to undefined
  const resolvedVersion = version || undefined;
  const subdir = hashSubdir || pathSubdir;

  return {
    uri,
    name,
    ...(resolvedVersion && { version: resolvedVersion }),
    ...(subdir && { subdir }),
  };
}

// --- Internal helpers ---

type ParsedGitURI = ReturnType<typeof parseGitCloneURI>;

async function _cloneAndTar(
  parsed: ParsedGitURI,
  token?: string,
  files?: string[],
): Promise<TarOutput> {
  const tmpDir = await mkdtemp(join(tmpdir(), "giget-git-"));

  if (token && /[\r\n]/.test(token)) {
    throw new Error("Auth token must not contain newline characters");
  }

  // Pass auth via env vars instead of CLI args to avoid leaking tokens in process list.
  // Note: http.extraHeader only applies to HTTPS clones; SSH clones ignore it.
  const execEnv: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };
  if (token) {
    execEnv.GIT_CONFIG_COUNT = "1";
    execEnv.GIT_CONFIG_KEY_0 = "http.extraHeader";
    execEnv.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${token}`;
  }
  const execOpts = { env: execEnv, timeout: 60_000 };

  const status = _createStatus();

  const gitExec = (args: string[]) => _gitSpawn(args, execOpts, status);
  const gitExecIn = (args: string[]) => _gitSpawn(args, { ...execOpts, cwd: tmpDir }, status);

  try {
    const cloneArgs = ["clone", "--progress", "--depth", "1"];
    if (parsed.subdir || (files && files.length > 0)) {
      cloneArgs.push("--filter=blob:none", "--sparse", "--no-checkout");
    }
    if (parsed.version) {
      cloneArgs.push("--branch", parsed.version);
    }
    cloneArgs.push("--", parsed.uri, tmpDir);

    try {
      status.update("Cloning...");
      await gitExec(cloneArgs);
      status.update("Cloned.");
    } catch (cloneError) {
      // --branch only accepts branch/tag names, not commit hashes.
      // Fall back to: full clone + checkout for specific commits.
      // Most git servers don't support fetching arbitrary SHAs at depth 1.
      if (!parsed.version) {
        throw cloneError;
      }
      debug("Shallow clone failed, falling back to full clone:", cloneError);
      status.update("Shallow clone failed, cloning...");
      await rmAsync(tmpDir, { recursive: true, force: true });
      await mkdir(tmpDir, { recursive: true });
      await gitExecIn(["init"]);
      await gitExecIn(["remote", "add", "origin", parsed.uri]);
      await gitExecIn(["fetch", "origin"]);
      await gitExecIn(["checkout", parsed.version]);
      status.update("Fetched.");
    }

    const sparsePaths = [];
    if (files && files.length > 0) {
      sparsePaths.push(...files.map((f) => (parsed.subdir ? join(parsed.subdir, f) : f)));
    } else if (parsed.subdir) {
      sparsePaths.push(parsed.subdir);
    }

    if (sparsePaths.length > 0) {
      status.update(`Sparse checkout ${sparsePaths.length} paths...`);
      await gitExecIn(["sparse-checkout", "set", ...sparsePaths]);
      await gitExecIn(["checkout"]);
    }

    status.update("Packing...");

    // Create tar archive from the cloned repo (excluding .git)
    // If files are specified, they are already resolved relative to the repo root
    // (using subdir prefix if needed), so we tar from the root.
    // If only a subdir is specified, we tar from within that subdir.
    const tarDir =
      parsed.subdir && !(files && files.length > 0) ? join(tmpDir, parsed.subdir) : tmpDir;
    const { create } = await import("tar");
    status.done();
    const pack = create(
      {
        gzip: true,
        cwd: tarDir,
        filter: (path) =>
          !path.startsWith(".git/") &&
          path !== ".git" &&
          !path.startsWith("./.git/") &&
          path !== "./.git",
      },
      ["."],
    );
    // Pipe through PassThrough to get a proper Readable stream
    const stream = pack.pipe(new PassThrough());
    // Clean up tmpDir once the stream is fully consumed, errors, or is destroyed
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      rmAsync(tmpDir, { recursive: true, force: true });
    };
    stream.on("end", cleanup);
    stream.on("error", cleanup);
    stream.on("close", cleanup);
    return stream as TarOutput;
  } catch (error) {
    status.done();
    await rmAsync(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

const _spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function _gitSpawn(
  args: string[],
  opts: { env?: Record<string, string | undefined>; timeout?: number; cwd?: string },
  status?: ReturnType<typeof _createStatus>,
) {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn("git", args, {
      ...opts,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.resume();
    let lastLine = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      const str = chunk.toString();
      for (const line of str.split(/[\r\n]/)) {
        const clean = line.trim();
        if (clean) lastLine = clean;
      }
      if (status) {
        status.update(lastLine);
      }
    });
    proc.on("close", (code: number) => {
      if (code === 0) resolve(lastLine);
      else reject(new Error(`git ${args[0]} exited with code ${code}. Is git installed?`));
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error("git is not installed or not found in PATH"));
      } else {
        reject(err);
      }
    });
  });
}

function _createStatus() {
  const isTTY = process.stderr.isTTY;
  if (!isTTY) {
    return { update(_text: string) {}, done() {} };
  }
  let msg = "";
  let frame = 0;
  const render = () => {
    const spinner = _spinnerFrames[frame % _spinnerFrames.length];
    frame++;
    process.stderr.write(`\x1B[2K\r\x1B[2m${spinner} ${msg}\x1B[0m`);
  };
  const interval = setInterval(render, 80);
  return {
    update(text: string) {
      msg = text;
      render();
    },
    done() {
      clearInterval(interval);
      process.stderr.write("\x1B[2K\r");
    },
  };
}
