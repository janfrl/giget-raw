import { existsSync } from "node:fs";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "pathe";
import { expect, it, describe, beforeAll } from "vitest";
import { downloadTemplate } from "../src/index.ts";

// Disable cache by PREFER_OFFLINE=false vitest
const preferOffline = process.env.PREFER_OFFLINE !== "false";

// Use a larger timeout for tests that perform slow git clone that needs to
// clone the entire git history.
const GIT_SLOW_TEST_TIMEOUT = 10_000;

describe("downloadTemplate", () => {
  beforeAll(async () => {
    await rm(resolve(__dirname, ".tmp"), { recursive: true, force: true });
  });

  it("clone unjs/template", async () => {
    const destinationDirectory = resolve(__dirname, ".tmp/cloned");
    const { dir } = await downloadTemplate("gh:unjs/template", {
      dir: destinationDirectory,
      preferOffline,
    });
    expect(existsSync(resolve(dir, "package.json"))).toBe(true);
  });

  it("clone unjs/template using custom provider that returns stream", async () => {
    const destinationDirectory = resolve(__dirname, ".tmp/cloned-custom");
    const { dir } = await downloadTemplate("custom:unjs/template", {
      dir: destinationDirectory,
      preferOffline,
      providers: {
        custom: async (input) => {
          return {
            name: input.replaceAll("/", "-"),
            tar: async () => {
              const response = await fetch(`https://api.github.com/repos/${input}/tarball`);
              return response.body!;
            },
          };
        },
      },
    });
    expect(existsSync(resolve(dir, "package.json"))).toBe(true);
  });

  it("clone unjs/template using git provider", async () => {
    const destinationDirectory = resolve(__dirname, ".tmp/cloned-with-git");
    const { dir } = await downloadTemplate("git:unjs/template", {
      dir: destinationDirectory,
      preferOffline,
    });
    expect(existsSync(resolve(dir, "package.json"))).toBe(true);
    expect(existsSync(resolve(dir, ".git"))).toBe(false);
  });

  it(
    "clone unjs/template#e24616c using git provider (specific commit)",
    { timeout: GIT_SLOW_TEST_TIMEOUT },
    async () => {
      const destinationDirectory = resolve(__dirname, ".tmp/cloned-with-git-e24616c");
      const { dir } = await downloadTemplate("git:unjs/template#e24616c", {
        dir: destinationDirectory,
        preferOffline,
      });

      // The initial version of unjs/template still has .eslintrc
      expect(existsSync(resolve(dir, ".eslintrc"))).toBe(true);
    },
  );

  it(
    "clone nuxt/starter#v3 using git provider (specific branch)",
    { timeout: GIT_SLOW_TEST_TIMEOUT },
    async () => {
      const destinationDirectory = resolve(__dirname, ".tmp/nuxt-starter-v3");
      const { dir } = await downloadTemplate("git:nuxt/starter#v3", {
        dir: destinationDirectory,
        preferOffline,
      });

      expect(existsSync(resolve(dir, "nuxt.config.ts"))).toBe(true);
    },
  );

  it(
    "clone nuxt/starter#v3:public subdir (specific subdir)",
    { timeout: GIT_SLOW_TEST_TIMEOUT },
    async () => {
      const destinationDirectory = resolve(__dirname, ".tmp/nuxt3-starter-v3-public");
      const { dir } = await downloadTemplate("git:nuxt/starter#v3:public", {
        dir: destinationDirectory,
        preferOffline,
      });
      expect(existsSync(resolve(dir, "favicon.ico"))).toBe(true);
    },
  );

  it("clone unjs/template#:src (default branch, specific subdir)", async () => {
    const destinationDirectory = resolve(__dirname, ".tmp/unjs-template-src");
    const { dir } = await downloadTemplate("git:unjs/template#:src", {
      dir: destinationDirectory,
      preferOffline,
    });
    expect(existsSync(resolve(dir, "index.ts"))).toBe(true);
  });

  it("do not clone to exisiting dir", async () => {
    const destinationDirectory = resolve(__dirname, ".tmp/exisiting");
    await mkdir(destinationDirectory, { recursive: true }).catch(() => {});
    await writeFile(resolve(destinationDirectory, "test.txt"), "test");
    await expect(
      downloadTemplate("gh:unjs/template", { dir: destinationDirectory }),
    ).rejects.toThrow("already exists");
  });

  it("clone specific files from unjs/giget", async () => {
    const destinationDirectory = resolve(__dirname, ".tmp/cloned-files");
    const { dir } = await downloadTemplate("gh:unjs/giget", {
      dir: destinationDirectory,
      files: ["README.md", "package.json"],
      preferOffline,
    });
    expect(existsSync(resolve(dir, "README.md"))).toBe(true);
    expect(existsSync(resolve(dir, "package.json"))).toBe(true);
    expect(existsSync(resolve(dir, "src"))).toBe(false);
  });

  it("clone specific files from unjs/giget using git provider", async () => {
    const destinationDirectory = resolve(__dirname, ".tmp/cloned-files-git");
    const { dir } = await downloadTemplate("git:unjs/giget", {
      dir: destinationDirectory,
      files: ["README.md", "package.json"],
      preferOffline,
    });
    expect(existsSync(resolve(dir, "README.md"))).toBe(true);
    expect(existsSync(resolve(dir, "package.json"))).toBe(true);
    expect(existsSync(resolve(dir, "src"))).toBe(false);
  });

  it("clone with subdir and specific files", async () => {
    const destinationDirectory = resolve(__dirname, ".tmp/cloned-subdir-files");
    const { dir } = await downloadTemplate("gh:unjs/giget/templates", {
      dir: destinationDirectory,
      files: ["unjs.json"],
      preferOffline,
    });
    expect(existsSync(resolve(dir, "unjs.json"))).toBe(true);
    expect(existsSync(resolve(dir, "nuxt.json"))).toBe(false);
  });

  it("clone with conflict skip in non-empty directory", async () => {
    const destinationDirectory = resolve(__dirname, ".tmp/cloned-conflict-skip-nonempty");
    await mkdir(destinationDirectory, { recursive: true });
    await writeFile(resolve(destinationDirectory, "README.md"), "EXISTING");
    await writeFile(resolve(destinationDirectory, "OTHER.txt"), "OTHER");

    const { dir } = await downloadTemplate("gh:unjs/giget", {
      dir: destinationDirectory,
      files: ["README.md", "package.json"],
      conflict: "skip",
      preferOffline,
    });
    const readme = await readFile(resolve(dir, "README.md"), "utf-8");
    expect(readme).toBe("EXISTING");
    expect(existsSync(resolve(dir, "package.json"))).toBe(true);
    expect(existsSync(resolve(dir, "OTHER.txt"))).toBe(true);
  });

  it("clone with conflict overwrite", async () => {
    const destinationDirectory = resolve(__dirname, ".tmp/cloned-conflict-overwrite");
    await mkdir(destinationDirectory, { recursive: true });
    await writeFile(resolve(destinationDirectory, "README.md"), "EXISTING");

    const { dir } = await downloadTemplate("gh:unjs/giget", {
      dir: destinationDirectory,
      files: ["README.md"],
      conflict: "overwrite",
      preferOffline,
    });
    const content = await readFile(resolve(dir, "README.md"), "utf-8");
    expect(content).not.toBe("EXISTING");
  });
});
