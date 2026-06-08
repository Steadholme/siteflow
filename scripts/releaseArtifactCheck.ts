import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sensitiveOutputReasons } from "./evidenceSecretScan.js";
import { runInstallProfileCheck } from "./installProfileCheck.js";
import { requiredReleaseArtifactCheckNames } from "./releaseArtifactContracts.js";

type ArtifactStatus = "passed" | "blocked";
type CheckStatus = "pass" | "fail";

export interface ReleaseArtifactCheckOptions {
  rootDir?: string;
  artifactDirs?: string[];
  packagePath?: string;
  manifestPath?: string;
  deploymentArtifactManifestPath?: string;
  deploymentDetailPath?: string;
  writeDeploymentArtifactManifestPath?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  runAudit?: boolean;
  commandRunner?: ReleaseArtifactCommandRunner;
  now?: () => Date;
}

export interface ReleaseArtifactCommand {
  executable: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export interface ReleaseArtifactCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ReleaseArtifactCommandRunner = (command: ReleaseArtifactCommand) => Promise<ReleaseArtifactCommandResult>;

export interface ReleaseArtifactCheck {
  name: string;
  status: CheckStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReleaseArtifactManifestEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface ReleaseArtifactManifest {
  schemaVersion: "siteflow.releaseArtifactManifest.v1";
  name: "siteflow-release-artifact-manifest";
  generatedAt: string;
  rootDir: string;
  checksum: string;
  artifacts: ReleaseArtifactManifestEntry[];
}

export interface ReleaseDeploymentArtifactManifestEvidence {
  release?: ReleaseDeploymentDetailIdentity;
  functions: Record<string, unknown>[];
  runtimeIsolation?: string;
  functionRuntimeIsolation?: string;
  runtime?: Record<string, unknown>;
  functionRuntime?: Record<string, unknown>;
}

interface ReleaseDeploymentDetailIdentity {
  commitRef?: string;
  repository?: string;
  branch?: string;
  targetEnvironment?: string;
}

interface ReleaseDeploymentArtifactManifestReadResult {
  manifest: ReleaseDeploymentArtifactManifestEvidence;
  identity?: ReleaseDeploymentDetailIdentity;
  identityFindings: string[];
}

export interface ReleaseArtifactCheckResult {
  name: "siteflow-release-artifact-check";
  status: ArtifactStatus;
  checkedAt: string;
  rootDir: string;
  artifactDirs: string[];
  manifestPath?: string;
  deploymentArtifactManifestPath?: string;
  selectedEvidence: {
    commitRef: string | null;
    repository: string | null;
    branch: string | null;
    targetEnvironment: string | null;
    fileCount: number;
    totalBytes: number;
    checksum: string;
    packageBinSiteflow: string | null;
    installProfileStatus: string | null;
    dependencyPolicyStatus: string | null;
    auditExitCode: number | null;
  };
  manifest: ReleaseArtifactManifest;
  artifactManifest?: ReleaseDeploymentArtifactManifestEvidence;
  checks: ReleaseArtifactCheck[];
  exitCode: number;
}

interface ParsedArgs {
  rootDir?: string;
  artifactDirs: string[];
  packagePath?: string;
  manifestPath?: string;
  deploymentArtifactManifestPath?: string;
  deploymentDetailPath?: string;
  writeDeploymentArtifactManifestPath?: string;
  commitRef?: string;
  repo?: string;
  branch?: string;
  targetEnvironment?: string;
  runAudit: boolean;
  json: boolean;
  help: boolean;
}

interface CliIo {
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
}

interface ArtifactFile {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
}

interface UnsafeArtifactEntry {
  path: string;
  reason: string;
}

interface SensitivePattern {
  label: string;
  pattern: RegExp;
}

interface PackageMetadata {
  private?: unknown;
  bin?: {
    siteflow?: unknown;
  };
  files?: unknown;
  engines?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
}

interface NpmPackFile {
  path: string;
  size?: number;
  mode?: number;
}

const defaultArtifactDirs = ["dist", "dist-cli", "dist-server", "dist-worker"];
const expectedSiteflowBin = "./dist-cli/cli/index.js";
const allowedPackRootFiles = new Set([
  "package.json",
  "README",
  "README.md",
  "README.txt",
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENCE",
  "LICENCE.md",
  "NOTICE",
  "NOTICE.md"
]);
const allowedPackDirs = ["dist/", "dist-cli/", "dist-server/", "dist-worker/"];
const requiredPackFiles = [
  "package.json",
  "dist/index.html",
  "dist-cli/cli/index.js",
  "dist-server/server/index.js",
  "dist-worker/worker/index.js"
];
const containerPipelineFiles = {
  dockerfile: "Dockerfile",
  dockerignore: ".dockerignore",
  workflow: ".github/workflows/release-image.yml"
};
const forbiddenPackPatterns: SensitivePattern[] = [
  { label: "workflow directory", pattern: /^\.workflow\// },
  { label: "github workflow directory", pattern: /^\.github\// },
  { label: "environment file", pattern: /^\.env(?:\.|$)/ },
  { label: "source directory", pattern: /^(?:src|server|worker|cli|scripts|tests|test-results|docs)\// },
  { label: "node_modules directory", pattern: /^node_modules\// },
  { label: "test file", pattern: /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i },
  { label: "typescript config", pattern: /^tsconfig(?:\.[^/]*)?\.json$/ },
  { label: "vite config", pattern: /^vite\.config\.[cm]?[jt]s$/ },
  { label: "playwright config", pattern: /^playwright\.config\.[cm]?[jt]s$/ }
];
const forbiddenLifecycleScripts = [
  "prepack",
  "prepare",
  "postpack",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish"
];
const sensitivePatterns: SensitivePattern[] = [
  { label: "secret canary value", pattern: /SITEFLOW_SECRET_CANARY_20260515/ },
  { label: "fixture build secret echo", pattern: /buildSecretEcho/ },
  { label: "fixture audit secret probe", pattern: /secretProbe/ },
  { label: "fixture provider token log", pattern: /Loaded provider token/ },
  { label: "fixture route bearer config", pattern: /proxy_set_header Authorization Bearer/ },
  { label: "fixture table export", pattern: /siteflowFixtures/ },
  { label: "fixture delivery secret field", pattern: /deliverySecret/ },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { label: "URL credentials", pattern: /[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:[^@\s/]+@/i },
  { label: "Bearer token", pattern: /\bBearer\s+(?=[A-Za-z0-9._~+/=-]{16,}\b)(?=[A-Za-z0-9._~+/=-]*[._~+/=-])[A-Za-z0-9._~+/=-]+/i }
];

function isEntrypoint() {
  const entryPath = process.argv[1];
  return Boolean(entryPath && import.meta.url === pathToFileURL(entryPath).href);
}

function packageManagerExecutable(name: string) {
  return process.platform === "win32" && !name.endsWith(".cmd") ? `${name}.cmd` : name;
}

function productionAuditCommand(rootDir: string): ReleaseArtifactCommand {
  const auditArgs = ["audit", "--omit=dev", "--audit-level=moderate", "--json"];
  const npmExecPath = process.env.npm_execpath;

  if (npmExecPath) {
    return {
      executable: process.execPath,
      args: [npmExecPath, ...auditArgs],
      cwd: rootDir,
      env: process.env
    };
  }

  return {
    executable: packageManagerExecutable("npm"),
    args: auditArgs,
    cwd: rootDir,
    env: process.env
  };
}

function npmPackDryRunCommand(rootDir: string): ReleaseArtifactCommand {
  const packArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const npmExecPath = process.env.npm_execpath;

  if (npmExecPath) {
    return {
      executable: process.execPath,
      args: [npmExecPath, ...packArgs],
      cwd: rootDir,
      env: process.env
    };
  }

  return {
    executable: packageManagerExecutable("npm"),
    args: packArgs,
    cwd: rootDir,
    env: process.env
  };
}

function dependencyPolicyCommand(rootDir: string): ReleaseArtifactCommand {
  return {
    executable: process.execPath,
    args: [path.join(rootDir, "scripts", "releaseDependencyPolicyCheck.mjs"), "--root", rootDir, "--json"],
    cwd: rootDir,
    env: process.env
  };
}

function normalizeArtifactPath(value: string) {
  return value.replace(/\\/g, "/");
}

function normalizePackPath(value: string) {
  const withoutPackageRoot = normalizeArtifactPath(value).replace(/^\.\//, "").replace(/^package\//, "");
  const normalized = path.posix.normalize(withoutPackageRoot);

  return normalized === "." ? "" : normalized.replace(/^\.\//, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectValues(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }

  if (isRecord(value)) {
    return Object.values(value).filter(isRecord);
  }

  return [];
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nestedRecord(candidate: unknown, keys: string[]) {
  let current = candidate;

  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return isRecord(current) ? current : undefined;
}

function nestedValue(candidate: unknown, keys: string[]) {
  let current = candidate;

  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

async function pathExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(filePath: string) {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

  if (!isRecord(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }

  return parsed;
}

function sanitizeRuntimeIsolationObject(value: unknown) {
  if (!isRecord(value)) {
    return undefined;
  }

  const isolation = stringField(value.isolation);
  const isolationMode = stringField(value.isolationMode);
  const runtimeIsolation = stringField(value.runtimeIsolation);

  if (!isolation && !isolationMode && !runtimeIsolation) {
    return undefined;
  }

  return {
    ...(isolation ? { isolation } : {}),
    ...(isolationMode ? { isolationMode } : {}),
    ...(runtimeIsolation ? { runtimeIsolation } : {})
  };
}

function sanitizeFunctionEntry(entry: Record<string, unknown>) {
  const runtime = sanitizeRuntimeIsolationObject(entry.runtime);
  const functionRuntime = sanitizeRuntimeIsolationObject(entry.functionRuntime);

  return {
    ...(stringField(entry.path) ? { path: stringField(entry.path) } : {}),
    ...(stringField(entry.sourcePath) ? { sourcePath: stringField(entry.sourcePath) } : {}),
    ...(stringField(entry.runtime) ? { runtime: stringField(entry.runtime) } : {}),
    ...(stringField(entry.runtimeIsolation) ? { runtimeIsolation: stringField(entry.runtimeIsolation) } : {}),
    ...(stringField(entry.functionRuntimeIsolation) ? { functionRuntimeIsolation: stringField(entry.functionRuntimeIsolation) } : {}),
    ...(runtime ? { runtime } : {}),
    ...(functionRuntime ? { functionRuntime } : {})
  };
}

function deploymentArtifactManifestFromJson(parsed: Record<string, unknown>, sourceLabel: string): ReleaseDeploymentArtifactManifestEvidence {
  const manifest =
    nestedRecord(parsed, ["lineage", "artifact", "manifest"]) ??
    nestedRecord(parsed, ["artifact", "manifest"]) ??
    nestedRecord(parsed, ["deployment", "artifactManifest"]) ??
    nestedRecord(parsed, ["artifactManifest"]) ??
    parsed;

  if (!isRecord(manifest)) {
    throw new Error(`${sourceLabel} must contain a deployment artifact manifest object.`);
  }

  const runtime = sanitizeRuntimeIsolationObject(manifest.runtime);
  const functionRuntime = sanitizeRuntimeIsolationObject(manifest.functionRuntime);
  const identity = deploymentDetailIdentityFromJson(parsed);
  const release = Object.fromEntries(
    Object.entries(identity).filter(([, value]) => Boolean(value))
  ) as ReleaseDeploymentDetailIdentity;

  return {
    ...(Object.keys(release).length > 0 ? { release } : {}),
    functions: objectValues(manifest.functions).map(sanitizeFunctionEntry),
    ...(stringField(manifest.runtimeIsolation) ? { runtimeIsolation: stringField(manifest.runtimeIsolation) } : {}),
    ...(stringField(manifest.functionRuntimeIsolation) ? { functionRuntimeIsolation: stringField(manifest.functionRuntimeIsolation) } : {}),
    ...(runtime ? { runtime } : {}),
    ...(functionRuntime ? { functionRuntime } : {})
  };
}

function firstStringField(root: Record<string, unknown>, paths: string[][]) {
  for (const candidatePath of paths) {
    const value = stringField(nestedValue(root, candidatePath));

    if (value) {
      return value;
    }
  }

  return undefined;
}

function ownerNameFromValue(value: unknown) {
  if (typeof value === "string") {
    return stringField(value);
  }

  if (!isRecord(value)) {
    return undefined;
  }

  return stringField(value.login) ?? stringField(value.username) ?? stringField(value.name);
}

function repositoryNameFromValue(value: unknown) {
  const direct = stringField(value);

  if (direct?.includes("/")) {
    return direct;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const fullName = stringField(value.fullName) ?? stringField(value.full_name);

  if (fullName) {
    return fullName;
  }

  const owner = ownerNameFromValue(value.owner) ?? ownerNameFromValue(value.namespace);
  const name = stringField(value.name) ?? stringField(value.repo);

  return owner && name ? `${owner}/${name}` : undefined;
}

function firstRepositoryName(root: Record<string, unknown>, paths: string[][]) {
  for (const candidatePath of paths) {
    const repository = repositoryNameFromValue(nestedValue(root, candidatePath));

    if (repository) {
      return repository;
    }
  }

  return undefined;
}

function deploymentDetailIdentityFromJson(parsed: Record<string, unknown>): ReleaseDeploymentDetailIdentity {
  return {
    commitRef: firstStringField(parsed, [
      ["release", "commitRef"],
      ["release", "commitSha"],
      ["lineage", "sourceEvent", "commitSha"],
      ["sourceEvent", "commitSha"],
      ["deployment", "commitSha"],
      ["commitSha"],
      ["commitRef"]
    ]),
    repository: firstRepositoryName(parsed, [
      ["release", "repository"],
      ["release", "repo"],
      ["lineage", "sourceEvent", "repository"],
      ["sourceEvent", "repository"],
      ["project", "repository"],
      ["repository"]
    ]),
    branch: firstStringField(parsed, [
      ["release", "branch"],
      ["lineage", "sourceEvent", "branch"],
      ["sourceEvent", "branch"],
      ["deployment", "branch"],
      ["branch"]
    ]),
    targetEnvironment: firstStringField(parsed, [
      ["release", "targetEnvironment"],
      ["release", "environment"],
      ["deployment", "environment"],
      ["lineage", "deployment", "environment"],
      ["targetEnvironment"],
      ["environment"],
      ["release", "targetEnvironment"]
    ])
  };
}

function valuesMatch(expected: string, actual: string, field: keyof ReleaseDeploymentDetailIdentity) {
  if (field === "repository") {
    return expected.toLowerCase() === actual.toLowerCase();
  }

  return expected === actual;
}

function deploymentDetailIdentityFindings(
  identity: ReleaseDeploymentDetailIdentity,
  options: ReleaseArtifactCheckOptions,
  sourceLabel: string
) {
  const expected: ReleaseDeploymentDetailIdentity = {
    commitRef: stringValue(options.commitRef),
    repository: stringValue(options.repo),
    branch: stringValue(options.branch),
    targetEnvironment: stringValue(options.targetEnvironment)
  };
  const labels: Record<keyof ReleaseDeploymentDetailIdentity, string> = {
    commitRef: "commitRef",
    repository: "repository",
    branch: "branch",
    targetEnvironment: "targetEnvironment"
  };
  const findings: string[] = [];

  for (const field of Object.keys(expected) as Array<keyof ReleaseDeploymentDetailIdentity>) {
    const expectedValue = expected[field];

    if (!expectedValue) {
      continue;
    }

    const actualValue = identity[field];

    if (!actualValue) {
      findings.push(`${sourceLabel} must include ${labels[field]} to bind the candidate deployment to the release evidence.`);
    } else if (!valuesMatch(expectedValue, actualValue, field)) {
      findings.push(`${sourceLabel} ${labels[field]} must be ${expectedValue}, found ${actualValue}.`);
    }
  }

  return findings;
}

async function readDeploymentArtifactManifestEvidence(options: ReleaseArtifactCheckOptions): Promise<ReleaseDeploymentArtifactManifestReadResult | undefined> {
  if (options.deploymentArtifactManifestPath && options.deploymentDetailPath) {
    throw new Error("Pass only one of --deployment-artifact-manifest or --deployment-detail.");
  }

  const sourcePath = options.deploymentArtifactManifestPath ?? options.deploymentDetailPath;

  if (!sourcePath) {
    return undefined;
  }

  const parsed = await readJsonObject(sourcePath);
  const manifest = deploymentArtifactManifestFromJson(parsed, sourcePath);

  if (!options.deploymentDetailPath) {
    const identity = deploymentDetailIdentityFromJson(parsed);

    return {
      manifest,
      identity,
      identityFindings: deploymentDetailIdentityFindings(identity, options, sourcePath)
    };
  }

  const identity = deploymentDetailIdentityFromJson(parsed);

  return {
    manifest,
    identity,
    identityFindings: deploymentDetailIdentityFindings(identity, options, sourcePath)
  };
}

function pathWithinRoot(rootDir: string, candidatePath: string) {
  const relative = path.relative(rootDir, candidatePath);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizedArtifactDir(rootDir: string, artifactDir: string) {
  const trimmed = artifactDir.trim();

  if (!trimmed) {
    return {
      valid: false as const,
      path: artifactDir,
      reason: "artifact directory must not be empty"
    };
  }

  const absoluteDir = path.resolve(rootDir, trimmed);

  if (!pathWithinRoot(rootDir, absoluteDir)) {
    return {
      valid: false as const,
      path: normalizeArtifactPath(trimmed),
      reason: "artifact directory must stay within the repository root"
    };
  }

  const relativePath = normalizeArtifactPath(path.relative(rootDir, absoluteDir));

  if (!relativePath || relativePath === ".") {
    return {
      valid: false as const,
      path: normalizeArtifactPath(trimmed),
      reason: "artifact directory must be a named release artifact subdirectory"
    };
  }

  return {
    valid: true as const,
    path: relativePath
  };
}

function resolveOutputPath(rootDir: string, outputPath: string, label: string) {
  const resolved = path.isAbsolute(outputPath)
    ? path.resolve(outputPath)
    : path.resolve(rootDir, outputPath);

  if (!path.isAbsolute(outputPath) && (!pathWithinRoot(rootDir, resolved) || resolved === rootDir)) {
    throw new Error(`${label} must stay within the repository root.`);
  }

  if (resolved === rootDir) {
    throw new Error(`${label} must point to a file, not the repository root.`);
  }

  return resolved;
}

async function collectFiles(
  rootDir: string,
  artifactDir: string,
  unsafeEntries: UnsafeArtifactEntry[]
): Promise<ArtifactFile[]> {
  const absoluteDir = path.resolve(rootDir, artifactDir);
  const dirStats = await lstat(absoluteDir);

  if (dirStats.isSymbolicLink()) {
    unsafeEntries.push({
      path: normalizeArtifactPath(path.relative(rootDir, absoluteDir)),
      reason: "artifact directory must not be a symlink"
    });
    return [];
  }

  if (!dirStats.isDirectory()) {
    unsafeEntries.push({
      path: normalizeArtifactPath(path.relative(rootDir, absoluteDir)),
      reason: "artifact entry must be a directory or regular file"
    });
    return [];
  }

  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: ArtifactFile[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(absoluteDir, entry.name);
    const relativePath = normalizeArtifactPath(path.relative(rootDir, absolutePath));

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(rootDir, path.relative(rootDir, absolutePath), unsafeEntries)));
      continue;
    }

    if (!entry.isFile()) {
      unsafeEntries.push({
        path: relativePath,
        reason: entry.isSymbolicLink()
          ? "artifact entry must not be a symlink"
          : "artifact entry must be a regular file"
      });
      continue;
    }

    const stats = await stat(absolutePath);

    files.push({
      absolutePath,
      relativePath,
      sizeBytes: stats.size
    });
  }

  return files;
}

async function collectArtifactFiles(rootDir: string, artifactDirs: string[]) {
  const missingDirs: string[] = [];
  const files: ArtifactFile[] = [];
  const unsafeEntries: UnsafeArtifactEntry[] = [];

  for (const artifactDir of artifactDirs) {
    const normalizedDir = normalizedArtifactDir(rootDir, artifactDir);

    if (!normalizedDir.valid) {
      unsafeEntries.push({
        path: normalizedDir.path,
        reason: normalizedDir.reason
      });
      continue;
    }

    const absoluteDir = path.resolve(rootDir, normalizedDir.path);

    if (!await pathExists(absoluteDir)) {
      missingDirs.push(normalizedDir.path);
      continue;
    }

    files.push(...await collectFiles(rootDir, normalizedDir.path, unsafeEntries));
  }

  return {
    missingDirs,
    unsafeEntries,
    files: files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  };
}

async function createManifest(rootDir: string, files: ArtifactFile[], generatedAt: string): Promise<ReleaseArtifactManifest> {
  const checksum = createHash("sha256");
  const artifacts: ReleaseArtifactManifestEntry[] = [];

  for (const file of files) {
    const contents = await readFile(file.absolutePath);

    checksum.update(file.relativePath);
    checksum.update("\0");
    checksum.update(contents);
    artifacts.push({
      path: file.relativePath,
      sizeBytes: file.sizeBytes,
      sha256: createHash("sha256").update(contents).digest("hex")
    });
  }

  return {
    schemaVersion: "siteflow.releaseArtifactManifest.v1",
    name: "siteflow-release-artifact-manifest",
    generatedAt,
    rootDir,
    checksum: `sha256:${checksum.digest("hex")}`,
    artifacts
  };
}

async function scanSensitiveArtifacts(files: ArtifactFile[]) {
  const findings: Array<{ path: string; pattern: string }> = [];

  for (const file of files) {
    const contents = (await readFile(file.absolutePath)).toString("utf8");

    for (const { label, pattern } of sensitivePatterns) {
      pattern.lastIndex = 0;

      if (pattern.test(contents)) {
        findings.push({ path: file.relativePath, pattern: label });
      }
    }

    for (const reason of sensitiveOutputReasons(contents, { maxFindings: 5 })) {
      findings.push({ path: file.relativePath, pattern: reason });
    }
  }

  return findings;
}

async function scanSensitivePackFiles(rootDir: string, packFiles: NpmPackFile[]) {
  const files: ArtifactFile[] = [];

  for (const packFile of packFiles) {
    const absolutePath = path.resolve(rootDir, packFile.path);

    if (pathWithinRoot(rootDir, absolutePath) && await pathExists(absolutePath)) {
      files.push({
        absolutePath,
        relativePath: packFile.path,
        sizeBytes: packFile.size ?? 0
      });
    }
  }

  return scanSensitiveArtifacts(files);
}

async function sourceMapFindings(files: ArtifactFile[]) {
  const findings: Array<{ path: string; reason: string }> = [];

  for (const file of files) {
    if (!file.relativePath.endsWith(".map")) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(await readFile(file.absolutePath, "utf8")) as unknown;
    } catch {
      findings.push({
        path: file.relativePath,
        reason: "source map must be valid JSON if it is included in release artifacts"
      });
      continue;
    }

    if (!isRecord(parsed)) {
      findings.push({
        path: file.relativePath,
        reason: "source map must be a JSON object"
      });
      continue;
    }

    const sourcesContent = parsed.sourcesContent;
    const sources = parsed.sources;

    if (Array.isArray(sourcesContent) && sourcesContent.some((entry) => typeof entry === "string" && entry.trim())) {
      findings.push({
        path: file.relativePath,
        reason: "source maps must not embed sourcesContent in release artifacts"
      });
    }

    if (Array.isArray(sources)) {
      for (const source of sources) {
        if (typeof source !== "string") {
          continue;
        }

        const normalized = normalizeArtifactPath(source);

        if (
          path.posix.isAbsolute(normalized) ||
          /^[A-Za-z]:\//.test(normalized) ||
          normalized === ".." ||
          normalized.startsWith("../") ||
          normalized.includes("/../") ||
          /(?:^|\/)\.env(?:\.|$)/.test(normalized) ||
          normalized.includes("node_modules/.cache/")
        ) {
          findings.push({
            path: file.relativePath,
            reason: "source map sources must not expose absolute, escaping, env, or cache paths"
          });
          break;
        }
      }
    }
  }

  return findings;
}

function artifactTopologyFindings(files: ArtifactFile[], unsafeEntries: UnsafeArtifactEntry[]) {
  const findings: Array<{ path: string; reason: string }> = [];

  findings.push(...unsafeEntries);

  for (const file of files) {
    if (/\.(?:test|spec)\.js$/i.test(file.relativePath)) {
      findings.push({
        path: file.relativePath,
        reason: "test files must not be included in release artifacts"
      });
    }

    if (
      file.relativePath.startsWith("dist-cli/") &&
      file.relativePath.endsWith(".js") &&
      !file.relativePath.startsWith("dist-cli/cli/") &&
      !file.relativePath.startsWith("dist-cli/scripts/") &&
      !file.relativePath.startsWith("dist-cli/src/")
    ) {
      findings.push({
        path: file.relativePath,
        reason: "compiled CLI files must live under dist-cli/cli, dist-cli/scripts, or dist-cli/src"
      });
    }
  }

  return findings;
}

function normalizeBinPath(value: string) {
  return normalizeArtifactPath(value.replace(/^\.\//, ""));
}

async function validatePackageBin(rootDir: string, packagePath: string) {
  const absolutePackagePath = path.resolve(rootDir, packagePath);
  const rawPackage = await readFile(absolutePackagePath, "utf8");
  const parsed = JSON.parse(rawPackage) as PackageMetadata;
  const siteflowBin = typeof parsed.bin?.siteflow === "string" ? parsed.bin.siteflow : null;
  const expectedBinPath = normalizeBinPath(expectedSiteflowBin);
  const actualBinPath = siteflowBin ? normalizeBinPath(siteflowBin) : null;
  const targetPath = actualBinPath ? path.resolve(rootDir, actualBinPath) : null;
  const targetExists = targetPath ? await pathExists(targetPath) : false;
  const hasNodeShebang = targetExists && targetPath
    ? (await readFile(targetPath, "utf8")).startsWith("#!/usr/bin/env node")
    : false;

  return {
    siteflowBin,
    passed: actualBinPath === expectedBinPath && targetExists && hasNodeShebang,
    targetExists,
    hasNodeShebang
  };
}

function parseNpmPackFiles(stdout: string): NpmPackFile[] {
  const parsed = JSON.parse(stdout) as unknown;
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;

  if (!isRecord(pack) || !Array.isArray(pack.files)) {
    throw new Error("npm pack dry-run output must contain a files array.");
  }

  return pack.files.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string") {
      throw new Error("npm pack dry-run file entries must include string paths.");
    }

    return {
      path: normalizePackPath(entry.path),
      ...(typeof entry.size === "number" ? { size: entry.size } : {}),
      ...(typeof entry.mode === "number" ? { mode: entry.mode } : {})
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function packageFilesAllowlistFindings(pkg: PackageMetadata) {
  const files = Array.isArray(pkg.files) ? pkg.files : [];

  if (files.length === 0) {
    return ["package.json must define a files allowlist for release packaging."];
  }

  const allowedEntries = new Set(allowedPackDirs);
  const findings: string[] = [];

  for (const entry of files) {
    if (typeof entry !== "string" || !allowedEntries.has(entry.endsWith("/") ? entry : `${entry}/`)) {
      findings.push(`package.json files entry is not allowed: ${String(entry)}`);
    }
  }

  for (const required of allowedPackDirs) {
    if (!files.some((entry) => typeof entry === "string" && (entry === required || `${entry}/` === required))) {
      findings.push(`package.json files must include ${required}`);
    }
  }

  return findings;
}

function packageMetadataPolicyFindings(pkg: PackageMetadata) {
  const findings: string[] = [];
  const nodeEngine = typeof pkg.engines?.node === "string" ? pkg.engines.node.trim() : "";

  if (pkg.private !== true) {
    findings.push("package.json private must remain true until npm publish is an explicit release target.");
  }

  if (!/(^|\s)>=\s*20(?:\.0\.0)?(?:\s|$)/.test(nodeEngine)) {
    findings.push("package.json engines.node must declare >=20.0.0 for the ESM CLI/runtime package.");
  }

  return findings;
}

function forbiddenLifecycleScriptFindings(pkg: PackageMetadata) {
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};

  return forbiddenLifecycleScripts
    .filter((script) => typeof scripts[script] === "string")
    .map((script) => `package.json must not define ${script} for release packaging.`);
}

function packPathFindings(packFiles: NpmPackFile[]) {
  const findings: Array<{ path: string; reason: string }> = [];

  for (const file of packFiles) {
    if (
      !file.path ||
      path.posix.isAbsolute(file.path) ||
      /^[A-Za-z]:\//.test(file.path) ||
      file.path === ".." ||
      file.path.startsWith("../") ||
      file.path.includes("/../")
    ) {
      findings.push({
        path: file.path,
        reason: "file path must not escape the package root"
      });
    }

    const pathAllowed = allowedPackRootFiles.has(file.path) || allowedPackDirs.some((dir) => file.path.startsWith(dir));

    if (!pathAllowed) {
      findings.push({
        path: file.path,
        reason: "file is outside the release package allowlist"
      });
    }

    for (const { label, pattern } of forbiddenPackPatterns) {
      pattern.lastIndex = 0;

      if (pattern.test(file.path)) {
        findings.push({
          path: file.path,
          reason: `${label} must not be included in the npm package`
        });
      }
    }
  }

  return findings;
}

function packRequiredFileFindings(packFiles: NpmPackFile[]) {
  const paths = new Set(packFiles.map((file) => file.path));
  const missing = requiredPackFiles.filter((file) => !paths.has(file));

  if (!packFiles.some((file) => /^dist\/assets\/.+\.js$/i.test(file.path))) {
    missing.push("dist/assets/*.js");
  }

  if (!packFiles.some((file) => /^dist\/assets\/.+\.css$/i.test(file.path))) {
    missing.push("dist/assets/*.css");
  }

  return missing;
}

async function readPackageMetadata(rootDir: string, packagePath: string) {
  return JSON.parse(await readFile(path.resolve(rootDir, packagePath), "utf8")) as PackageMetadata;
}

async function containerImagePipelineFindings(rootDir: string) {
  const findings: string[] = [];
  const dockerfilePath = path.resolve(rootDir, containerPipelineFiles.dockerfile);
  const dockerignorePath = path.resolve(rootDir, containerPipelineFiles.dockerignore);
  const workflowPath = path.resolve(rootDir, containerPipelineFiles.workflow);
  const dockerfileExists = await pathExists(dockerfilePath);
  const dockerignoreExists = await pathExists(dockerignorePath);
  const workflowExists = await pathExists(workflowPath);

  if (!dockerfileExists) {
    findings.push("Dockerfile is required so the installer default image can be built from this release source.");
  }

  if (!dockerignoreExists) {
    findings.push(".dockerignore is required to keep local node_modules, dist outputs, env files, and workflow scratch files out of image build context.");
  }

  if (!workflowExists) {
    findings.push(".github/workflows/release-image.yml is required to publish the installer default GHCR image.");
  }

  if (dockerfileExists) {
    const dockerfile = await readFile(dockerfilePath, "utf8");

    if (!/npm\s+run\s+build/.test(dockerfile)) {
      findings.push("Dockerfile must run npm run build from source.");
    }

    if (!dockerfile.includes("releaseDependencyPolicyCheck.mjs") || !/node\s+scripts\/releaseDependencyPolicyCheck\.mjs\s+--json/.test(dockerfile)) {
      findings.push("Dockerfile must run releaseDependencyPolicyCheck.mjs before npm ci in build and runtime install stages.");
    }

    for (const dir of defaultArtifactDirs) {
      if (!dockerfile.includes(`/app/${dir}`) || !dockerfile.includes(`./${dir}`)) {
        findings.push(`Dockerfile must copy ${dir} into the runtime image.`);
      }
    }

    if (!/docker(?:\.io|-ce-cli|\s+CLI|\s+cli)/i.test(dockerfile)) {
      findings.push("Dockerfile runtime image must include Docker CLI support for the worker Docker runner.");
    }
  }

  if (dockerignoreExists) {
    const dockerignoreLines = (await readFile(dockerignorePath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const ignored of [
      "node_modules",
      "dist",
      "dist-cli",
      "dist-server",
      "dist-worker",
      ".env",
      "release-image-evidence*.json",
      "release-evidence*.json",
      "release-post-promotion-evidence*.json",
      "release-source-cleanup-plan*.json"
    ]) {
      if (!dockerignoreLines.includes(ignored)) {
        findings.push(`.dockerignore must exclude ${ignored}.`);
      }
    }
  }

  if (workflowExists) {
    const workflow = await readFile(workflowPath, "utf8");

    if (!workflow.includes("ghcr.io/siteflow/siteflow")) {
      findings.push("release image workflow must publish the installer default ghcr.io/siteflow/siteflow image unless an explicit image override is used.");
    }

    if (!workflow.includes("docker/build-push-action")) {
      findings.push("release image workflow must use docker/build-push-action to build and push the image.");
    }

    if (!workflow.includes("release:dependency:policy")) {
      findings.push("release image workflow must run release:dependency:policy before npm ci.");
    }

    if (!/push:\s+true/.test(workflow)) {
      findings.push("release image workflow must push the built image.");
    }

    if (!/provenance:\s+true/.test(workflow)) {
      findings.push("release image workflow must enable provenance attestation.");
    }

    if (!/sbom:\s+true/.test(workflow)) {
      findings.push("release image workflow must enable SBOM attestation.");
    }

    if (!workflow.includes("steps.build.outputs.digest") || !workflow.includes("release-image-evidence.json")) {
      findings.push("release image workflow must write machine-readable digest evidence.");
    }

    if (!workflow.includes("actions/upload-artifact") || !workflow.includes("release-image-evidence")) {
      findings.push("release image workflow must upload release image evidence as a workflow artifact.");
    }
  }

  return findings;
}

async function runNpmPackDryRun(
  rootDir: string,
  commandRunner: ReleaseArtifactCommandRunner
) {
  return commandRunner(npmPackDryRunCommand(rootDir));
}

function truncateOutput(value: string, maxLength = 4096) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated]` : value;
}

function commandOutputEvidence(stdout: string, stderr: string) {
  const stdoutSensitiveReasons = sensitiveOutputReasons(stdout, { maxFindings: 10 });
  const stderrSensitiveReasons = sensitiveOutputReasons(stderr, { maxFindings: 10 });
  const redactedPreview = "[redacted: sensitive command output omitted]";

  return {
    outputSensitive: stdoutSensitiveReasons.length > 0 || stderrSensitiveReasons.length > 0,
    stdoutPreview: stdoutSensitiveReasons.length > 0 ? redactedPreview : truncateOutput(stdout),
    stderrPreview: stderrSensitiveReasons.length > 0 ? redactedPreview : truncateOutput(stderr),
    ...(stdoutSensitiveReasons.length > 0 ? { stdoutSensitiveReasons } : {}),
    ...(stderrSensitiveReasons.length > 0 ? { stderrSensitiveReasons } : {})
  };
}

function stringValue(value: string | undefined) {
  return value?.trim() || undefined;
}

function actualCommandRunner(command: ReleaseArtifactCommand): Promise<ReleaseArtifactCommandResult> {
  return new Promise((resolve) => {
    let child;

    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        env: command.env,
        shell: process.platform === "win32" && command.executable.endsWith(".cmd"),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (error) => {
      resolve({
        exitCode: 1,
        stdout: "",
        stderr: error.message
      });
    });

    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}

async function runProductionAudit(
  rootDir: string,
  commandRunner: ReleaseArtifactCommandRunner
) {
  return commandRunner(productionAuditCommand(rootDir));
}

async function runDependencyPolicyCheck(
  rootDir: string,
  commandRunner: ReleaseArtifactCommandRunner
) {
  return commandRunner(dependencyPolicyCommand(rootDir));
}

function parseDependencyPolicyStatus(stdout: string) {
  try {
    const parsed = JSON.parse(stdout) as { status?: unknown; checks?: unknown };

    return {
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      failedChecks: Array.isArray(parsed.checks)
        ? parsed.checks
          .filter((entry): entry is { name?: unknown; status?: unknown; message?: unknown } =>
            isRecord(entry) && entry.status === "fail"
          )
          .map((entry) => ({
            name: typeof entry.name === "string" ? entry.name : "unknown",
            message: typeof entry.message === "string" && sensitiveOutputReasons(entry.message).length === 0
              ? entry.message
              : "Dependency policy check failed."
          }))
        : []
    };
  } catch {
    return {
      status: undefined,
      failedChecks: []
    };
  }
}

function check(name: string, passed: boolean, message: string, details?: Record<string, unknown>): ReleaseArtifactCheck {
  return {
    name,
    status: passed ? "pass" : "fail",
    message,
    ...(details ? { details } : {})
  };
}

export async function runReleaseArtifactCheck(options: ReleaseArtifactCheckOptions = {}): Promise<ReleaseArtifactCheckResult> {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const artifactDirs = options.artifactDirs?.length ? options.artifactDirs : defaultArtifactDirs;
  const packagePath = options.packagePath ?? "package.json";
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const commitRef = stringValue(options.commitRef);
  const repository = stringValue(options.repo);
  const branch = stringValue(options.branch);
  const targetEnvironment = stringValue(options.targetEnvironment);
  const requiresDeploymentArtifactManifest = targetEnvironment === "production";
  const checks: ReleaseArtifactCheck[] = [];
  const { missingDirs, unsafeEntries, files } = await collectArtifactFiles(rootDir, artifactDirs);
  const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  const manifest = await createManifest(rootDir, files, checkedAt);
  const sensitiveFindings = await scanSensitiveArtifacts(files);
  const topologyFindings = artifactTopologyFindings(files, unsafeEntries);
  const sourceMapIssues = await sourceMapFindings(files);
  const commandRunner = options.commandRunner ?? actualCommandRunner;
  let artifactManifest: ReleaseDeploymentArtifactManifestEvidence | undefined;
  let deploymentArtifactManifestOutputPath: string | undefined;
  let siteflowBin: string | null = null;
  let installProfileStatus: string | null = null;
  let dependencyPolicyStatus: string | null = null;
  let auditExitCode: number | null = null;

  checks.push(check(
    "release_identity",
    Boolean(commitRef && repository && branch && targetEnvironment),
    commitRef && repository && branch && targetEnvironment
      ? "Release artifact evidence is bound to commit, repository, branch, and target environment."
      : "Release artifact evidence must include commit, repository, branch, and target environment.",
    { commitRef: commitRef ?? null, repository: repository ?? null, branch: branch ?? null, targetEnvironment: targetEnvironment ?? null }
  ));

  checks.push(check(
    "artifact_directories_present",
    missingDirs.length === 0 && files.length > 0,
    missingDirs.length === 0
      ? `Collected ${files.length} artifact files from ${artifactDirs.length} directories.`
      : `Missing artifact directories: ${missingDirs.join(", ")}.`,
    { missingDirs, fileCount: files.length }
  ));

  checks.push(check(
    "sha256_manifest",
    manifest.artifacts.length === files.length && manifest.artifacts.length > 0,
    `Computed SHA-256 manifest for ${manifest.artifacts.length} files.`,
    { fileCount: manifest.artifacts.length, totalBytes, checksum: manifest.checksum }
  ));

  try {
    const deploymentArtifactManifestReadResult = await readDeploymentArtifactManifestEvidence(options);
    const deploymentArtifactManifestIdentityFindings = deploymentArtifactManifestReadResult?.identityFindings ?? [];

    artifactManifest = deploymentArtifactManifestReadResult?.manifest;
    if (options.writeDeploymentArtifactManifestPath) {
      if (!artifactManifest) {
        throw new Error("--write-deployment-artifact-manifest requires --deployment-artifact-manifest or --deployment-detail.");
      }

      deploymentArtifactManifestOutputPath = resolveOutputPath(
        rootDir,
        options.writeDeploymentArtifactManifestPath,
        "Deployment artifact manifest output path"
      );
      await mkdir(path.dirname(deploymentArtifactManifestOutputPath), { recursive: true });
      await writeFile(deploymentArtifactManifestOutputPath, `${JSON.stringify(artifactManifest, null, 2)}\n`, "utf8");
    }

    const deploymentArtifactManifestPassed =
      (!requiresDeploymentArtifactManifest || Boolean(artifactManifest)) &&
      deploymentArtifactManifestIdentityFindings.length === 0;

    checks.push(check(
      "deployment_artifact_manifest",
      deploymentArtifactManifestPassed,
      deploymentArtifactManifestIdentityFindings.length > 0
        ? `Deployment detail identity mismatch: ${deploymentArtifactManifestIdentityFindings[0]}`
        : artifactManifest
        ? `Attached deployment artifact manifest function summary for ${artifactManifest.functions.length} function(s).`
        : requiresDeploymentArtifactManifest
          ? "Production release artifact evidence must attach the deployment artifact manifest or deployment detail so function runtime isolation can be checked before promotion."
          : "Deployment artifact manifest was not required for this non-production artifact check.",
      artifactManifest
        ? {
          functionCount: artifactManifest.functions.length,
          ...(deploymentArtifactManifestReadResult?.identity ? { deploymentIdentity: deploymentArtifactManifestReadResult.identity } : {}),
          ...(deploymentArtifactManifestIdentityFindings.length > 0 ? { identityFindings: deploymentArtifactManifestIdentityFindings } : {}),
          ...(deploymentArtifactManifestOutputPath ? { outputPath: deploymentArtifactManifestOutputPath } : {})
        }
        : undefined
    ));
  } catch (error) {
    checks.push(check(
      "deployment_artifact_manifest",
      false,
      error instanceof Error ? error.message : String(error)
    ));
  }

  checks.push(check(
    "sensitive_artifact_scan",
    sensitiveFindings.length === 0,
    sensitiveFindings.length === 0
      ? "No canary, fixture, token, or credential patterns were found in release artifacts."
      : `Found ${sensitiveFindings.length} sensitive artifact pattern match(es).`,
    sensitiveFindings.length > 0 ? { findings: sensitiveFindings.slice(0, 20) } : undefined
  ));

  checks.push(check(
    "artifact_topology",
    topologyFindings.length === 0 && sourceMapIssues.length === 0,
    topologyFindings.length === 0 && sourceMapIssues.length === 0
      ? "Release artifact topology contains no test outputs or stale compiled CLI files."
      : `Found ${topologyFindings.length + sourceMapIssues.length} release artifact topology issue(s).`,
    topologyFindings.length > 0 || sourceMapIssues.length > 0
      ? { findings: [...topologyFindings, ...sourceMapIssues].slice(0, 20) }
      : undefined
  ));

  try {
    const packageMetadata = await readPackageMetadata(rootDir, packagePath);
    const npmPack = await runNpmPackDryRun(rootDir, commandRunner);
    let packFiles: NpmPackFile[] = [];
    let packageAllowlistFindings: string[] = [];
    let lifecycleFindings: string[] = [];
    let pathFindings: Array<{ path: string; reason: string }> = [];
    let missingPackFiles: string[] = [];
    let packSensitiveFindings: Array<{ path: string; pattern: string }> = [];
    let parseError: string | undefined;
    const npmPackOutput = commandOutputEvidence(npmPack.stdout, npmPack.stderr);

    if (npmPack.exitCode === 0) {
      try {
        packFiles = parseNpmPackFiles(npmPack.stdout);
        packageAllowlistFindings = packageFilesAllowlistFindings(packageMetadata);
        lifecycleFindings = forbiddenLifecycleScriptFindings(packageMetadata);
        pathFindings = packPathFindings(packFiles);
        missingPackFiles = packRequiredFileFindings(packFiles);
        packSensitiveFindings = await scanSensitivePackFiles(rootDir, packFiles);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }

    const packPassed = npmPack.exitCode === 0 &&
      !parseError &&
      packageAllowlistFindings.length === 0 &&
      lifecycleFindings.length === 0 &&
      pathFindings.length === 0 &&
      missingPackFiles.length === 0 &&
      packSensitiveFindings.length === 0 &&
      !npmPackOutput.outputSensitive;

    checks.push(check(
      "npm_pack_manifest",
      packPassed,
      packPassed
        ? `npm pack dry-run contains ${packFiles.length} allowed release package file(s).`
        : "npm pack dry-run must contain only allowed release files and all required runtime entries.",
      packPassed
        ? { fileCount: packFiles.length }
        : {
            exitCode: npmPack.exitCode,
            fileCount: packFiles.length,
            packageAllowlistFindings,
            lifecycleFindings,
            pathFindings: pathFindings.slice(0, 20),
            missingPackFiles,
            sensitiveFindings: packSensitiveFindings.slice(0, 20),
            ...(parseError ? { parseError } : {}),
            ...(npmPack.exitCode === 0 && !npmPackOutput.outputSensitive
              ? {}
              : npmPackOutput)
          }
    ));
  } catch (error) {
    checks.push(check(
      "npm_pack_manifest",
      false,
      error instanceof Error ? error.message : String(error)
    ));
  }

  try {
    const packageMetadata = await readPackageMetadata(rootDir, packagePath);
    const metadataFindings = packageMetadataPolicyFindings(packageMetadata);

    checks.push(check(
      "package_metadata_policy",
      metadataFindings.length === 0,
      metadataFindings.length === 0
        ? "package.json metadata declares the supported Node runtime and private artifact distribution policy."
        : "package.json metadata must declare the supported Node runtime and current artifact distribution policy.",
      metadataFindings.length > 0 ? { findings: metadataFindings } : undefined
    ));
  } catch (error) {
    checks.push(check(
      "package_metadata_policy",
      false,
      error instanceof Error ? error.message : String(error)
    ));
  }

  try {
    const binResult = await validatePackageBin(rootDir, packagePath);
    siteflowBin = binResult.siteflowBin;

    checks.push(check(
      "package_bin_siteflow",
      binResult.passed,
      binResult.passed
        ? `package.json bin.siteflow points at ${expectedSiteflowBin} and the compiled entry has a Node shebang.`
        : `package.json bin.siteflow must point at ${expectedSiteflowBin} and the compiled entry must exist with a Node shebang.`,
      { siteflowBin: binResult.siteflowBin, targetExists: binResult.targetExists, hasNodeShebang: binResult.hasNodeShebang }
    ));
  } catch (error) {
    checks.push(check(
      "package_bin_siteflow",
      false,
      error instanceof Error ? error.message : String(error)
    ));
  }

  try {
    const imagePipelineFindings = await containerImagePipelineFindings(rootDir);

    checks.push(check(
      "container_image_pipeline",
      imagePipelineFindings.length === 0,
      imagePipelineFindings.length === 0
        ? "Dockerfile and GHCR release image workflow can build and publish the installer default runtime image."
        : "Release image pipeline is incomplete.",
      imagePipelineFindings.length === 0
        ? {
            dockerfile: containerPipelineFiles.dockerfile,
            dockerignore: containerPipelineFiles.dockerignore,
            workflow: containerPipelineFiles.workflow
          }
        : { findings: imagePipelineFindings }
    ));
  } catch (error) {
    checks.push(check(
      "container_image_pipeline",
      false,
      error instanceof Error ? error.message : String(error)
    ));
  }

  const installProfile = runInstallProfileCheck({ now: options.now });
  installProfileStatus = installProfile.status;

  checks.push(check(
    "install_profile",
    installProfile.status === "passed",
    installProfile.status === "passed"
      ? "Rendered single-host install profile satisfies static production posture checks."
      : "Rendered single-host install profile must satisfy static production posture checks.",
    installProfile.status === "passed"
      ? {
          checksPassed: installProfile.selectedEvidence.checksPassed,
          checksTotal: installProfile.selectedEvidence.checksTotal
        }
      : {
          failedChecks: installProfile.checks
            .filter((entry) => entry.status === "fail")
            .map((entry) => ({
              name: entry.name,
              message: entry.message
            }))
        }
  ));

  const dependencyPolicy = await runDependencyPolicyCheck(rootDir, commandRunner);
  const dependencyPolicyOutput = parseDependencyPolicyStatus(dependencyPolicy.stdout);
  const dependencyPolicyCommandOutput = commandOutputEvidence(dependencyPolicy.stdout, dependencyPolicy.stderr);
  dependencyPolicyStatus = dependencyPolicyOutput.status ?? null;

  checks.push(check(
    "dependency_policy",
    dependencyPolicy.exitCode === 0 && dependencyPolicyOutput.status === "passed" && !dependencyPolicyCommandOutput.outputSensitive,
    dependencyPolicy.exitCode === 0 && dependencyPolicyOutput.status === "passed" && !dependencyPolicyCommandOutput.outputSensitive
      ? "Dependency policy check passed for package manifest and lockfile sources."
      : "Dependency policy check must pass for package manifest and lockfile sources.",
    dependencyPolicy.exitCode === 0 && dependencyPolicyOutput.status === "passed" && !dependencyPolicyCommandOutput.outputSensitive
      ? { status: dependencyPolicyOutput.status }
      : {
          exitCode: dependencyPolicy.exitCode,
          status: dependencyPolicyOutput.status ?? "unknown",
          failedChecks: dependencyPolicyOutput.failedChecks,
          ...dependencyPolicyCommandOutput
        }
  ));

  if (options.runAudit ?? true) {
    const audit = await runProductionAudit(rootDir, commandRunner);
    const auditOutput = commandOutputEvidence(audit.stdout, audit.stderr);
    auditExitCode = audit.exitCode;

    checks.push(check(
      "production_dependency_audit",
      audit.exitCode === 0 && !auditOutput.outputSensitive,
      audit.exitCode === 0 && !auditOutput.outputSensitive
        ? "npm audit reported no moderate-or-higher production dependency vulnerabilities."
        : "npm audit reported moderate-or-higher production dependency vulnerabilities or could not complete.",
      audit.exitCode === 0 && !auditOutput.outputSensitive
        ? { stdoutBytes: Buffer.byteLength(audit.stdout, "utf8"), stderrBytes: Buffer.byteLength(audit.stderr, "utf8") }
        : {
            exitCode: audit.exitCode,
            ...auditOutput
          }
    ));
  } else {
    checks.push(check(
      "production_dependency_audit",
      true,
      "Production dependency audit was skipped by operator request."
    ));
  }

  if (options.manifestPath) {
    const manifestPath = resolveOutputPath(rootDir, options.manifestPath, "Release artifact manifest path");
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  const passed = checks.every((entry) => entry.status === "pass");

  return {
    name: "siteflow-release-artifact-check",
    status: passed ? "passed" : "blocked",
    checkedAt,
    rootDir,
    artifactDirs,
    ...(options.manifestPath ? { manifestPath: resolveOutputPath(rootDir, options.manifestPath, "Release artifact manifest path") } : {}),
    ...(deploymentArtifactManifestOutputPath ? { deploymentArtifactManifestPath: deploymentArtifactManifestOutputPath } : {}),
    selectedEvidence: {
      commitRef: commitRef ?? null,
      repository: repository ?? null,
      branch: branch ?? null,
      targetEnvironment: targetEnvironment ?? null,
      fileCount: files.length,
      totalBytes,
      checksum: manifest.checksum,
      packageBinSiteflow: siteflowBin,
      installProfileStatus,
      dependencyPolicyStatus,
      auditExitCode
    },
    manifest,
    ...(artifactManifest ? { artifactManifest } : {}),
    checks,
    exitCode: passed ? 0 : 1
  };
}

function readArgValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

export function parseReleaseArtifactCheckArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    artifactDirs: [],
    runAudit: true,
    json: false,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--root") {
      parsed.rootDir = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--commit-ref") {
      parsed.commitRef = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--repo") {
      parsed.repo = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--branch") {
      parsed.branch = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--target-environment") {
      parsed.targetEnvironment = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--dir") {
      parsed.artifactDirs.push(readArgValue(args, index, arg));
      index += 1;
    } else if (arg === "--package") {
      parsed.packagePath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--manifest") {
      parsed.manifestPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--deployment-artifact-manifest") {
      parsed.deploymentArtifactManifestPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--deployment-detail") {
      parsed.deploymentDetailPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--write-deployment-artifact-manifest") {
      parsed.writeDeploymentArtifactManifestPath = readArgValue(args, index, arg);
      index += 1;
    } else if (arg === "--skip-audit") {
      parsed.runAudit = false;
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

export function releaseArtifactCheckUsage() {
  return [
    "Usage: npm run --silent release:artifacts:check -- [options]",
    "",
    "Options:",
    "  --root <dir>        Repository root. Default: current working directory.",
    "  --dir <dir>         Artifact directory to include. Repeatable. Defaults to dist, dist-cli, dist-server, dist-worker.",
    "  --package <file>    package.json path. Default: package.json.",
    "  --manifest <file>   Write SHA-256 artifact manifest JSON.",
    "  --deployment-artifact-manifest <file>  Deployment artifact manifest JSON used to prove function runtime isolation.",
    "  --deployment-detail <file>  Deployment detail JSON containing lineage.artifact.manifest.",
    "  --write-deployment-artifact-manifest <file>  Write sanitized deployment artifact manifest JSON.",
    "  --commit-ref <sha>  Release commit SHA.",
    "  --repo <owner/repo> Release repository.",
    "  --branch <branch>   Release branch.",
    "  --target-environment <name>  Target environment label.",
    "  --skip-audit        Skip npm audit --omit=dev --audit-level=moderate.",
    "  --json              Emit a single JSON result.",
    "  --help              Show this help."
  ].join("\n");
}

function writeHumanResult(result: ReleaseArtifactCheckResult, io: CliIo) {
  const output = result.status === "passed" ? io.stdout : io.stderr;

  output.write(`SiteFlow release artifact status: ${result.status}\n`);
  output.write(`Files: ${result.selectedEvidence.fileCount}\n`);
  output.write(`Bytes: ${result.selectedEvidence.totalBytes}\n`);
  output.write("Checks:\n");

  for (const entry of result.checks) {
    output.write(`- ${entry.name}: ${entry.status} - ${entry.message}\n`);
  }
}

export async function runReleaseArtifactCheckCli(
  args = process.argv.slice(2),
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
  baseOptions: Partial<ReleaseArtifactCheckOptions> = {}
) {
  let parsed: ParsedArgs;

  try {
    parsed = parseReleaseArtifactCheckArgs(args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    io.stderr.write(`${releaseArtifactCheckUsage()}\n`);
    return 2;
  }

  if (parsed.help) {
    io.stdout.write(`${releaseArtifactCheckUsage()}\n`);
    return 0;
  }

  const result = await runReleaseArtifactCheck({
    ...baseOptions,
    rootDir: parsed.rootDir,
    artifactDirs: parsed.artifactDirs.length > 0 ? parsed.artifactDirs : undefined,
    packagePath: parsed.packagePath,
    manifestPath: parsed.manifestPath,
    deploymentArtifactManifestPath: parsed.deploymentArtifactManifestPath,
    deploymentDetailPath: parsed.deploymentDetailPath,
    writeDeploymentArtifactManifestPath: parsed.writeDeploymentArtifactManifestPath,
    commitRef: parsed.commitRef,
    repo: parsed.repo,
    branch: parsed.branch,
    targetEnvironment: parsed.targetEnvironment,
    runAudit: parsed.runAudit
  });

  if (parsed.json) {
    const output = result.status === "passed" ? io.stdout : io.stderr;
    output.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    writeHumanResult(result, io);
  }

  return result.exitCode;
}

if (isEntrypoint()) {
  runReleaseArtifactCheckCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
