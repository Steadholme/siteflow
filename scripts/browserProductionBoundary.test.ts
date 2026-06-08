import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const sourceRoot = path.join(repoRoot, "src");
const sourceExtensions = new Set([".ts", ".tsx"]);
const fixtureIslandFiles = new Set([
  "src/lib/api/fixtureClient.ts",
  "src/lib/api/browserProductionFixtureClient.ts",
  "src/lib/fixtures/scenarios.ts",
  "src/lib/fixtures/siteflow.fixtures.ts"
]);
const allowedFixtureClientImporters = new Set([
  "src/lib/api/clientFactory.ts"
]);

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = await stat(absolute);

    if (stats.isDirectory()) {
      files.push(...await sourceFiles(absolute));
      continue;
    }

    if (stats.isFile() && sourceExtensions.has(path.extname(entry))) {
      files.push(absolute);
    }
  }

  return files;
}

function normalizePath(filePath: string) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function isTestSource(relativePath: string) {
  return relativePath.startsWith("src/test/") ||
    /\.test\.[cm]?[tj]sx?$/.test(relativePath) ||
    /\.spec\.[cm]?[tj]sx?$/.test(relativePath);
}

function importSpecifiers(contents: string) {
  return [
    ...contents.matchAll(/\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g),
    ...contents.matchAll(/\bexport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g)
  ].map((match) => match[1]);
}

describe("browser production module boundaries", () => {
  it("keeps fixture modules out of production-reachable source imports", async () => {
    const violations: Array<{ file: string; importPath: string }> = [];

    for (const file of await sourceFiles(sourceRoot)) {
      const relativePath = normalizePath(file);

      if (isTestSource(relativePath) || fixtureIslandFiles.has(relativePath)) {
        continue;
      }

      const specifiers = importSpecifiers(await readFile(file, "utf8"));

      for (const importPath of specifiers) {
        if (importPath.startsWith("@lib/fixtures/") || importPath.includes("/fixtures/")) {
          violations.push({ file: relativePath, importPath });
        }

        if (
          importPath === "@lib/api/fixtureClient" &&
          !allowedFixtureClientImporters.has(relativePath)
        ) {
          violations.push({ file: relativePath, importPath });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
