import { lstatSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const buildDirs = ["dist", "dist-cli", "dist-server", "dist-worker"];

for (const buildDir of buildDirs) {
  const target = path.resolve(repoRoot, buildDir);

  if (!target.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Refusing to clean path outside repository: ${target}`);
  }

  try {
    const stats = lstatSync(target);

    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to clean symlinked build directory: ${target}`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      continue;
    }

    throw error;
  }

  rmSync(target, { recursive: true, force: true });
}
