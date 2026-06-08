import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptName = process.argv[2];
const scriptArgs = process.argv.slice(3);

if (!scriptName || scriptName.includes("/") || scriptName.includes("\\") || !scriptName.endsWith(".js")) {
  console.error("Usage: node scripts/runCompiledScript.mjs <compiled-script.js> [args...]");
  process.exit(2);
}

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempRoot = mkdtempSync(path.join(tmpdir(), "siteflow-scripts-"));
const tscPath = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: process.env,
    shell: false,
    stdio: "inherit"
  });

  if (result.error) {
    console.error(result.error.message);
    return 1;
  }

  if (result.signal) {
    console.error(`Command terminated by signal ${result.signal}.`);
    return 1;
  }

  return result.status ?? 0;
}

let exitCode = 1;

try {
  exitCode = run(process.execPath, [tscPath, "-p", "tsconfig.scripts.json", "--outDir", tempRoot]);

  if (exitCode === 0) {
    exitCode = run(process.execPath, [path.join(tempRoot, "scripts", scriptName), ...scriptArgs]);
  }
} finally {
  if (process.env.SITEFLOW_KEEP_COMPILED_SCRIPTS === "1") {
    console.error(`Keeping compiled scripts in ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

process.exit(exitCode);
