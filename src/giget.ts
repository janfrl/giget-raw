import { createWriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve, dirname } from "pathe";
import type { installDependencies } from "nypm";
import { cacheDirectory, download, debug, normalizeHeaders, sendFetch } from "./_utils.ts";
import { providers } from "./providers.ts";
import { registryProvider } from "./registry.ts";
import type { TemplateInfo, TemplateProvider } from "./types.ts";

type InstallOptions = Parameters<typeof installDependencies>[0];

export interface DownloadTemplateOptions {
  provider?: string;
  force?: boolean;
  forceClean?: boolean;
  offline?: boolean;
  preferOffline?: boolean;
  providers?: Record<string, TemplateProvider>;
  dir?: string;
  registry?: false | string;
  cwd?: string;
  auth?: string;
  install?: boolean | InstallOptions;
  silent?: boolean;
  strategy?: "skip" | "overwrite";
  files?: string[];
}

const sourceProtoRe = /^([\w+-.]+):/;

export type DownloadTemplateResult = Omit<TemplateInfo, "dir" | "source"> & {
  dir: string;
  source: string;
};

export async function downloadTemplate(
  input: string,
  options: DownloadTemplateOptions = {},
): Promise<DownloadTemplateResult> {
  options.registry = process.env.GIGET_REGISTRY ?? options.registry;
  options.auth = process.env.GIGET_AUTH ?? options.auth;

  const registry =
    options.registry === false
      ? undefined
      : registryProvider(options.registry, { auth: options.auth });

  let providerName: string = options.provider || (registry ? "registry" : "github");

  let source: string = input;
  const sourceProviderMatch = input.match(sourceProtoRe);
  if (sourceProviderMatch) {
    providerName = sourceProviderMatch[1]!;
    source = input.slice(sourceProviderMatch[0].length);
    if (providerName === "http" || providerName === "https") {
      source = input;
    }
  }

  // Handle <host>+git: prefix (e.g. gh+git:, github+git:, gitlab+git:)
  // Route to git provider with host prefix preserved for parseGitCloneURI
  if (providerName.endsWith("+git")) {
    const hostPrefix = providerName.slice(0, -4); // e.g. "gh", "github", "gitlab"
    source = `${hostPrefix}:${source}`;
    providerName = "git";
  }

  const provider = options.providers?.[providerName] || providers[providerName] || registry;
  if (!provider) {
    throw new Error(`Unsupported provider: ${providerName}`);
  }
  const template = await Promise.resolve()
    .then(() => provider(source, { auth: options.auth, files: options.files }))
    .catch((error) => {
      throw new Error(`Failed to download template from ${providerName}: ${error.message}`);
    });

  if (!template) {
    throw new Error(`Failed to resolve template from ${providerName}`);
  }

  // Sanitize name and defaultDir
  template.name = (template.name || "template").replace(/[^\da-z-]/gi, "-");
  template.defaultDir = (template.defaultDir || template.name).replace(/[^\da-z-]/gi, "-");

  // Raw download attempt (fast path for specific files if options.files is provided)
  if (template.raw && Array.isArray(options.files) && options.files.length > 0) {
    const files = options.files;
    const cwd = resolve(options.cwd || ".");
    const destDir = resolve(cwd, options.dir || template.defaultDir);
    let allFilesDownloadedRaw = true;

    try {
      for (const filePath of files) {
        const rawUrl = template.raw(filePath.replace(/^\//, ""));
        const outPath = resolve(destDir, filePath);
        await mkdir(dirname(outPath), { recursive: true });

        if (options.strategy !== "skip" || !existsSync(outPath)) {
          const res = await sendFetch(rawUrl, {
            validateStatus: true,
            headers: normalizeHeaders({
              Authorization: options.auth ? `Bearer ${options.auth}` : undefined,
              ...template.headers,
            }),
          });

          if (res.status >= 400) {
            allFilesDownloadedRaw = false;
            debug(
              `Raw download failed for ${rawUrl} (status: ${res.status}). Falling back to tarball.`,
            );
            break; // Exit loop, will proceed to tarball logic outside this block
          }
          const buffer = Buffer.from(await res.arrayBuffer());
          await writeFile(outPath, buffer);
        }
      }

      if (allFilesDownloadedRaw) {
        return {
          ...template,
          dir: destDir,
          source: files.join(", "),
        };
      }
    } catch (error: any) {
      allFilesDownloadedRaw = false;
      debug("Raw files download process failed:", error.message, "Falling back to tarball flow.");
    }
  }

  // Download template source
  const temporaryDirectory = resolve(cacheDirectory(), providerName, template.name);
  const tarPath = resolve(temporaryDirectory, (template.version || template.name) + ".tar.gz");

  if (options.preferOffline && existsSync(tarPath)) {
    options.offline = true;
  }
  if (!options.offline) {
    await mkdir(dirname(tarPath), { recursive: true });
    const s = Date.now();
    if (typeof template.tar === "function") {
      const tarFn = template.tar;
      await (async () => {
        const stream = await tarFn({ auth: options.auth });
        const nodeStream =
          stream instanceof Readable
            ? stream
            : Readable.fromWeb(stream as import("node:stream/web").ReadableStream);
        const fileStream = createWriteStream(tarPath);
        await pipeline(nodeStream, fileStream);
      })().catch((error) => {
        if (!existsSync(tarPath)) {
          throw error;
        }
        debug("Download error. Using cached version:", error);
        options.offline = true;
      });
    } else {
      await download(template.tar, tarPath, {
        headers: {
          Authorization: options.auth ? `Bearer ${options.auth}` : undefined,
          ...normalizeHeaders(template.headers),
        },
      }).catch((error) => {
        if (!existsSync(tarPath)) {
          throw error;
        }
        // Accept network errors if we have a cached version
        debug("Download error. Using cached version:", error);
        options.offline = true;
      });
    }
    debug(`Downloaded to ${tarPath} in ${Date.now() - s}ms`);
  }

  if (!existsSync(tarPath)) {
    throw new Error(`Tarball not found: ${tarPath} (offline: ${options.offline})`);
  }

  // Extract template
  const cwd = resolve(options.cwd || ".");
  const extractPath = resolve(cwd, options.dir || template.defaultDir);
  if (options.forceClean) {
    await rm(extractPath, { recursive: true, force: true });
  }
  if (
    !options.force &&
    !options.files &&
    existsSync(extractPath) &&
    readdirSync(extractPath).length > 0
  ) {
    if (options.strategy === "skip") {
      return {
        ...template,
        dir: extractPath,
        source,
      };
    }
    if (options.strategy !== "overwrite") {
      throw new Error(
        `Destination ${extractPath} already exists and is not empty. Use --force, --strategy=overwrite to overwrite, or --strategy=skip to skip.`,
      );
    }
  }
  await mkdir(extractPath, { recursive: true });

  const s = Date.now();
  const subdir = template.subdir?.replace(/^\//, "") || "";
  const { extract } = await import("tar");
  await extract({
    file: tarPath,
    cwd: extractPath,
    onReadEntry(entry) {
      entry.path = entry.path.split("/").splice(1).join("/");
      if (options.files && options.files.length > 0) {
        for (const file of options.files) {
          if (entry.path === file || entry.path.startsWith(file + "/")) {
            return;
          }
        }
        entry.path = "";
      } else if (subdir) {
        if (entry.path.startsWith(subdir + "/")) {
          // Rewrite path
          entry.path = entry.path.slice(subdir.length);
        } else {
          // Skip
          entry.path = "";
        }
      }
    },
  });
  debug(`Extracted to ${extractPath} in ${Date.now() - s}ms`);

  if (options.install) {
    debug("Installing dependencies...");
    const { installDependencies } = await import("nypm");
    await installDependencies({
      cwd: extractPath,
      silent: options.silent,
      ...(typeof options.install === "object" ? options.install : {}),
    });
  }

  return {
    ...template,
    source,
    dir: extractPath,
  };
}
