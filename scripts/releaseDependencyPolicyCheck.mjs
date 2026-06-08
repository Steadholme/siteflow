#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const checkName = "siteflow-release-dependency-policy-check";
const defaultMaxFindings = 50;
const dependencySections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const rootInstallLifecycleScripts = ["preinstall", "install", "postinstall", "prepare"];
const allowedDevInstallScripts = new Map([
  ["esbuild@0.21.5", "esbuild installs a platform-specific native binary."],
  ["fsevents@2.3.2", "optional macOS file watcher native package."],
  ["fsevents@2.3.3", "optional macOS file watcher native package."]
]);
const forbiddenSpecPattern = /^(?:git(?:\+ssh|\+https|\+http)?:|ssh:|https?:|file:|link:|workspace:|github:|gist:|gitlab:|bitbucket:)/i;
const registryPrefix = "https://registry.npmjs.org/";

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function stringMap(value) {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value)
    .filter((entry) => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(entries);
}

function mapsEqual(left, right) {
  return JSON.stringify(stringMap(left)) === JSON.stringify(stringMap(right));
}

function statusCheck(name, passed, message, details) {
  return {
    name,
    status: passed ? "pass" : "fail",
    message,
    ...(details ? { details } : {})
  };
}

function packageNameFromLockPath(lockPath) {
  const parts = lockPath.split("/");
  const index = parts.lastIndexOf("node_modules");

  if (index === -1 || index === parts.length - 1) {
    return undefined;
  }

  const first = parts[index + 1];

  if (first?.startsWith("@") && parts[index + 2]) {
    return `${first}/${parts[index + 2]}`;
  }

  return first;
}

function lockPackagePathForName(name) {
  return `node_modules/${name}`;
}

function manifestProtocolFindings(pkg) {
  const findings = [];

  for (const section of dependencySections) {
    const dependencies = stringMap(pkg[section]);

    for (const [name, spec] of Object.entries(dependencies)) {
      if (forbiddenSpecPattern.test(spec)) {
        findings.push({
          section,
          name,
          spec,
          reason: "dependency spec must come from the npm registry lockfile, not a git, URL, file, link, or workspace source"
        });
      }
    }
  }

  return findings;
}

function manifestLockDriftFindings(pkg, lockRoot) {
  const findings = [];

  for (const section of dependencySections) {
    if (!mapsEqual(pkg[section], lockRoot?.[section])) {
      findings.push({
        section,
        packageJson: stringMap(pkg[section]),
        packageLock: stringMap(lockRoot?.[section]),
        reason: "package.json and package-lock.json root dependency declarations must match"
      });
    }
  }

  return findings;
}

function prodDependencyFindings(pkg, lockPackages) {
  const findings = [];
  const dependencies = stringMap(pkg.dependencies);

  for (const [name] of Object.entries(dependencies)) {
    const lockPath = lockPackagePathForName(name);
    const entry = lockPackages[lockPath];

    if (!isRecord(entry)) {
      findings.push({
        name,
        lockPath,
        reason: "production dependency is missing from package-lock.json packages"
      });
      continue;
    }

    if (entry.dev === true) {
      findings.push({
        name,
        lockPath,
        reason: "production dependency is marked dev in package-lock.json"
      });
    }
  }

  return findings;
}

function lockSourceFindings(lockPackages) {
  const findings = [];

  for (const [lockPath, entry] of Object.entries(lockPackages)) {
    if (lockPath === "" || !isRecord(entry)) {
      continue;
    }

    const resolved = typeof entry.resolved === "string" ? entry.resolved : "";

    if (entry.link === true || entry.inBundle === true) {
      findings.push({
        lockPath,
        reason: "linked or bundled lockfile packages are not allowed in the release dependency graph"
      });
    }

    if (!resolved) {
      findings.push({
        lockPath,
        reason: "lockfile package must include a registry resolved tarball URL"
      });
      continue;
    }

    if (!resolved.startsWith(registryPrefix)) {
      findings.push({
        lockPath,
        resolved,
        reason: "lockfile package resolved URL must use the npm registry"
      });
      continue;
    }

    if (typeof entry.integrity !== "string" || !entry.integrity.trim()) {
      findings.push({
        lockPath,
        resolved,
        reason: "registry lockfile package must include integrity"
      });
    }
  }

  return findings;
}

function installScriptFindings(pkg, lockPackages) {
  const findings = [];
  const allowed = [];
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};

  for (const scriptName of rootInstallLifecycleScripts) {
    if (typeof scripts[scriptName] === "string" && scripts[scriptName].trim()) {
      findings.push({
        scope: "root",
        scriptName,
        reason: "root install lifecycle scripts must not run before release dependency policy checks"
      });
    }
  }

  for (const [lockPath, entry] of Object.entries(lockPackages)) {
    if (lockPath === "" || !isRecord(entry) || entry.hasInstallScript !== true) {
      continue;
    }

    const name = packageNameFromLockPath(lockPath);
    const version = typeof entry.version === "string" ? entry.version : undefined;
    const packageId = name && version ? `${name}@${version}` : undefined;

    if (entry.dev === true && packageId && allowedDevInstallScripts.has(packageId)) {
      allowed.push({
        lockPath,
        package: packageId,
        reason: allowedDevInstallScripts.get(packageId)
      });
      continue;
    }

    findings.push({
      lockPath,
      ...(packageId ? { package: packageId } : {}),
      dev: entry.dev === true,
      reason: entry.dev === true
        ? "dev dependency install script is not in the release dependency policy allowlist"
        : "production dependency install scripts are not allowed"
    });
  }

  return { findings, allowed };
}

export async function runReleaseDependencyPolicyCheck(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const maxFindings = Number.isInteger(options.maxFindings) && options.maxFindings > 0
    ? options.maxFindings
    : defaultMaxFindings;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const packagePath = path.join(rootDir, "package.json");
  const lockPath = path.join(rootDir, "package-lock.json");
  const checks = [];

  let pkg;
  let lock;

  try {
    pkg = await readJson(packagePath);
    lock = await readJson(lockPath);
  } catch (error) {
    checks.push(statusCheck(
      "dependency_policy_inputs",
      false,
      error instanceof Error ? error.message : String(error)
    ));

    return buildResult(rootDir, checkedAt, checks, undefined, undefined);
  }

  const lockRoot = isRecord(lock.packages) && isRecord(lock.packages[""]) ? lock.packages[""] : undefined;
  const lockPackages = isRecord(lock.packages) ? lock.packages : {};
  const protocolFindings = manifestProtocolFindings(pkg);
  const driftFindings = manifestLockDriftFindings(pkg, lockRoot);
  const prodFindings = prodDependencyFindings(pkg, lockPackages);
  const sourceFindings = lockSourceFindings(lockPackages);
  const installScripts = installScriptFindings(pkg, lockPackages);

  checks.push(statusCheck(
    "dependency_policy_inputs",
    Number(lock.lockfileVersion) >= 3 && isRecord(lockRoot),
    "package-lock.json must be lockfileVersion 3+ with a root packages entry.",
    {
      lockfileVersion: lock.lockfileVersion ?? null,
      hasRootPackage: Boolean(lockRoot)
    }
  ));
  checks.push(statusCheck(
    "dependency_manifest_protocols",
    protocolFindings.length === 0,
    protocolFindings.length === 0
      ? "Root dependency specs do not use git, URL, file, link, or workspace sources."
      : `Found ${protocolFindings.length} forbidden root dependency spec(s).`,
    protocolFindings.length > 0 ? { findings: protocolFindings.slice(0, maxFindings), total: protocolFindings.length } : undefined
  ));
  checks.push(statusCheck(
    "dependency_manifest_lock_sync",
    driftFindings.length === 0,
    driftFindings.length === 0
      ? "package.json and package-lock.json root dependency declarations match."
      : `Found ${driftFindings.length} package manifest/lock drift finding(s).`,
    driftFindings.length > 0 ? { findings: driftFindings.slice(0, maxFindings), total: driftFindings.length } : undefined
  ));
  checks.push(statusCheck(
    "production_dependency_lock_entries",
    prodFindings.length === 0,
    prodFindings.length === 0
      ? "Production dependencies are present in package-lock.json and not marked dev."
      : `Found ${prodFindings.length} production dependency lock finding(s).`,
    prodFindings.length > 0 ? { findings: prodFindings.slice(0, maxFindings), total: prodFindings.length } : undefined
  ));
  checks.push(statusCheck(
    "dependency_lock_sources",
    sourceFindings.length === 0,
    sourceFindings.length === 0
      ? "Lockfile packages resolve to npm registry tarballs with integrity."
      : `Found ${sourceFindings.length} lockfile source/integrity finding(s).`,
    sourceFindings.length > 0 ? { findings: sourceFindings.slice(0, maxFindings), total: sourceFindings.length } : undefined
  ));
  checks.push(statusCheck(
    "dependency_install_scripts",
    installScripts.findings.length === 0,
    installScripts.findings.length === 0
      ? "Install scripts are absent or limited to reviewed dev dependency allowlist entries."
      : `Found ${installScripts.findings.length} unapproved install script finding(s).`,
    {
      allowedDevInstallScripts: installScripts.allowed,
      ...(installScripts.findings.length > 0
        ? { findings: installScripts.findings.slice(0, maxFindings), total: installScripts.findings.length }
        : {})
    }
  ));

  return buildResult(rootDir, checkedAt, checks, pkg, lock);
}

function buildResult(rootDir, checkedAt, checks, pkg, lock) {
  const lockPackages = isRecord(lock?.packages) ? lock.packages : {};
  const passed = checks.every((check) => check.status === "pass");

  return {
    name: checkName,
    status: passed ? "passed" : "blocked",
    checkedAt,
    rootDir,
    selectedEvidence: {
      lockfileVersion: lock?.lockfileVersion ?? null,
      rootDependencyCount: Object.keys(stringMap(pkg?.dependencies)).length,
      rootDevDependencyCount: Object.keys(stringMap(pkg?.devDependencies)).length,
      lockPackageCount: Object.keys(lockPackages).length,
      allowedDevInstallScriptCount: checks
        .flatMap((check) => Array.isArray(check.details?.allowedDevInstallScripts) ? check.details.allowedDevInstallScripts : [])
        .length
    },
    checks,
    exitCode: passed ? 0 : 1
  };
}

function readArgValue(args, index, name) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

export function parseReleaseDependencyPolicyCheckArgs(args) {
  const parsed = {
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--root") {
      parsed.rootDir = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--max-findings") {
      const value = Number(readArgValue(args, index, arg));

      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max-findings must be a positive integer.");
      }

      parsed.maxFindings = value;
      index += 1;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--help") {
      parsed.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

export function usage() {
  return [
    "Usage: node scripts/releaseDependencyPolicyCheck.mjs [options]",
    "",
    "Options:",
    "  --root <dir>            Repository root. Default: current working directory.",
    `  --max-findings <n>      Maximum findings to include. Default: ${defaultMaxFindings}.`,
    "  --json                  Emit a single JSON result.",
    "  --help                  Show this help."
  ].join("\n");
}

async function main() {
  const parsed = parseReleaseDependencyPolicyCheckArgs(process.argv.slice(2));

  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const result = await runReleaseDependencyPolicyCheck(parsed);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const output = result.status === "passed" ? process.stdout : process.stderr;
    output.write(`SiteFlow release dependency policy: ${result.status}\n`);

    for (const check of result.checks) {
      output.write(`- ${check.name}: ${check.status} - ${check.message}\n`);
    }
  }

  process.exitCode = result.exitCode;
}

if (isEntrypoint()) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
