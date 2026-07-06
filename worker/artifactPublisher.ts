import { createHash, randomUUID } from "node:crypto";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactManifest, FunctionEntrypoint, SiteFlowId } from "../src/domain/siteflow.js";

export interface FunctionArtifactInput {
  path: string;
  sourcePath: string;
  artifactPath: string;
  runtime: FunctionEntrypoint["runtime"];
  runtimeIsolation?: FunctionEntrypoint["runtimeIsolation"];
  apiStyle?: FunctionEntrypoint["apiStyle"];
  handler?: FunctionEntrypoint["handler"];
  methods?: string[];
  timeoutMs?: number;
  memoryMb?: number;
  concurrency?: number;
  regions?: string[];
  failoverRegions?: string[];
}

export interface ArtifactExtraFileInput {
  artifactPath: string;
  contents: string | Buffer;
}

export interface ArtifactBlockedContentValue {
  label: string;
  value: string;
}

export interface ArtifactPublishOptions {
  buildJobId: SiteFlowId;
  sourceEventId: SiteFlowId;
  outputDirectory: string;
  artifactRoot: string;
  entrypoint?: string;
  functions?: FunctionArtifactInput[];
  extraFiles?: ArtifactExtraFileInput[];
  clientEnvironmentVariables?: Record<string, string>;
  metadata?: Record<string, unknown>;
  maxArtifactBytes?: number;
  maxArtifactFiles?: number;
  blockedContentValues?: ArtifactBlockedContentValue[];
}

export interface PublishedBuildArtifact {
  deploymentId: SiteFlowId;
  artifactRoot: string;
  entrypoint: string;
  fileCount: number;
  totalBytes: number;
  checksum: string;
  manifest: ArtifactManifest;
}

interface ArtifactFile {
  relativePath: string;
  size: number;
  sourcePath?: string;
  bytes?: Buffer;
}

interface PrecompressionStats {
  br: number;
  gzip: number;
}

interface ArtifactPublisherDependencies {
  randomUUID: () => string;
  writeFile: typeof writeFile;
}

const compressibleExtensions = new Set([
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".svg",
  ".txt",
  ".xml",
  ".webmanifest"
]);

function toPosixPath(value: string) {
  return value.split(path.sep).join("/");
}

function safeArtifactPath(filePath: string) {
  const normalized = path.posix.normalize(filePath.replace(/\\/g, "/")).replace(/^\/+/, "");

  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Invalid artifact file path: ${filePath}`);
  }

  return normalized;
}

function artifactFileSize(file: ArtifactFile) {
  return file.bytes ? file.bytes.byteLength : file.size;
}

async function artifactFileBytes(file: ArtifactFile) {
  if (file.bytes) {
    return file.bytes;
  }

  if (!file.sourcePath) {
    throw new Error(`Artifact file has no source path: ${file.relativePath}`);
  }

  file.bytes = await readFile(file.sourcePath);
  file.size = file.bytes.byteLength;
  return file.bytes;
}

function artifactDisplayPath(root: string, fullPath: string) {
  const relative = toPosixPath(path.relative(root, fullPath));

  return relative ? safeArtifactPath(relative) : ".";
}

async function pathExists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function assertDeploymentTargetAvailable(targetRoot: string) {
  if (await pathExists(targetRoot)) {
    throw new Error(`Deployment artifact target already exists: ${targetRoot}.`);
  }
}

async function removeDirectoryBestEffort(directory: string) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    // The deployment bytes are already immutable at this point; lock cleanup must not turn a publish into a failure.
  }
}

function normalizedBlockedContentValues(values: ArtifactBlockedContentValue[] | undefined) {
  const seen = new Set<string>();
  const normalized: ArtifactBlockedContentValue[] = [];

  for (const entry of values ?? []) {
    const value = entry.value.trim();

    if (value.length < 8 || seen.has(value)) {
      continue;
    }

    seen.add(value);
    normalized.push({
      label: entry.label.trim() || "secret",
      value
    });
  }

  return normalized;
}

async function assertNoBlockedContentValues(files: ArtifactFile[], values: ArtifactBlockedContentValue[]) {
  if (values.length === 0) {
    return;
  }

  const needles = values.map((entry) => ({
    label: entry.label,
    bytes: Buffer.from(entry.value, "utf8")
  }));

  for (const file of files) {
    const bytes = await artifactFileBytes(file);

    for (const needle of needles) {
      if (bytes.includes(needle.bytes)) {
        throw new Error(`Build artifact contains blocked secret value for ${needle.label} in ${file.relativePath}.`);
      }
    }
  }
}

function clientEnvironmentVariableMap(values: Record<string, string> | undefined) {
  return Object.fromEntries(
    Object.entries(values ?? {})
      .filter(([, value]) => typeof value === "string")
      .sort(([left], [right]) => left.localeCompare(right))
  ) as Record<string, string>;
}

function injectClientEnvironmentScript(html: string) {
  const script = '<script src="/__siteflow/env.js"></script>';

  if (html.includes("/__siteflow/env.js")) {
    return html;
  }

  // Insert right after <head>/<html>/<!doctype> (in that preference) so window.env is defined
  // before any app script, without ever placing content ahead of the doctype (which would force
  // quirks mode). Only a document with none of these gets the bare prepend (no doctype to displace).
  for (const pattern of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype\b[^>]*>/i]) {
    const match = html.match(pattern);

    if (match?.index !== undefined) {
      const insertAt = match.index + match[0].length;
      return `${html.slice(0, insertAt)}${script}${html.slice(insertAt)}`;
    }
  }

  return `${script}${html}`;
}

async function addClientEnvironmentShim(files: ArtifactFile[], artifactPaths: Set<string>, values: Record<string, string> | undefined) {
  const environmentVariables = clientEnvironmentVariableMap(values);
  const keys = Object.keys(environmentVariables);

  if (keys.length === 0) {
    return;
  }

  const shimPath = "__siteflow/env.js";

  if (artifactPaths.has(shimPath)) {
    throw new Error(`Client environment shim path conflicts with existing artifact: ${shimPath}`);
  }

  const shimBytes = Buffer.from(`window.env = Object.assign(window.env || {}, ${JSON.stringify(environmentVariables)});`, "utf8");
  files.push({
    relativePath: shimPath,
    bytes: shimBytes,
    size: shimBytes.byteLength
  });
  artifactPaths.add(shimPath);

  for (const file of files) {
    if (!file.relativePath.endsWith(".html")) {
      continue;
    }

    const original = await artifactFileBytes(file);
    const originalHtml = original.toString("utf8");
    const injected = injectClientEnvironmentScript(originalHtml);

    if (injected === originalHtml) {
      continue;
    }

    file.bytes = Buffer.from(injected, "utf8");
    file.size = file.bytes.byteLength;
  }
}

function assertArtifactBudget(files: ArtifactFile[], options: ArtifactPublishOptions, stage: string) {
  if (options.maxArtifactFiles !== undefined && files.length > options.maxArtifactFiles) {
    throw new Error(
      `Build artifact exceeds SITEFLOW_BUILD_MAX_ARTIFACT_FILES during ${stage}: ${files.length} > ${options.maxArtifactFiles}.`
    );
  }

  if (options.maxArtifactBytes !== undefined) {
    const totalBytes = files.reduce((total, file) => total + artifactFileSize(file), 0);

    if (totalBytes > options.maxArtifactBytes) {
      throw new Error(
        `Build artifact exceeds SITEFLOW_BUILD_MAX_ARTIFACT_BYTES during ${stage}: ${totalBytes} > ${options.maxArtifactBytes}.`
      );
    }
  }
}

async function collectArtifactFiles(root: string, current: string, files: ArtifactFile[]) {
  const currentStats = await lstat(current);

  if (currentStats.isSymbolicLink()) {
    throw new Error(`Build artifact output contains unsupported symlink entry: ${artifactDisplayPath(root, current)}.`);
  }

  if (!currentStats.isDirectory()) {
    throw new Error(`Build artifact output contains unsupported non-directory entry: ${artifactDisplayPath(root, current)}.`);
  }

  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const relativePath = safeArtifactPath(toPosixPath(path.relative(root, fullPath)));

    if (entry.isDirectory()) {
      await collectArtifactFiles(root, fullPath, files);
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(
        entry.isSymbolicLink()
          ? `Build artifact output contains unsupported symlink entry: ${relativePath}.`
          : `Build artifact output contains unsupported non-file entry: ${relativePath}.`
      );
    }

    const stats = await stat(fullPath);

    files.push({
      relativePath,
      sourcePath: fullPath,
      size: stats.size
    });
  }
}

function unsafeSourceMapSource(source: string) {
  const normalized = source.replace(/\\/g, "/");

  return path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    /(?:^|\/)\.env(?:\.|$)/.test(normalized) ||
    normalized.includes("node_modules/.cache/");
}

async function assertNoUnsafeSourceMaps(files: ArtifactFile[]) {
  for (const file of files) {
    if (!file.relativePath.endsWith(".map")) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse((await artifactFileBytes(file)).toString("utf8")) as unknown;
    } catch {
      throw new Error(`Build artifact source map must be valid JSON: ${file.relativePath}.`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Build artifact source map must be a JSON object: ${file.relativePath}.`);
    }

    const record = parsed as Record<string, unknown>;

    if (
      Array.isArray(record.sourcesContent) &&
      record.sourcesContent.some((entry) => typeof entry === "string" && entry.trim())
    ) {
      throw new Error(`Build artifact source map embeds sourcesContent: ${file.relativePath}.`);
    }

    if (
      Array.isArray(record.sources) &&
      record.sources.some((entry) => typeof entry === "string" && unsafeSourceMapSource(entry))
    ) {
      throw new Error(`Build artifact source map exposes unsafe source paths: ${file.relativePath}.`);
    }
  }
}

function shouldPrecompress(file: ArtifactFile) {
  if (file.relativePath.startsWith(".siteflow/functions/")) {
    return false;
  }

  if (file.relativePath.endsWith(".br") || file.relativePath.endsWith(".gz")) {
    return false;
  }

  return compressibleExtensions.has(path.posix.extname(file.relativePath).toLowerCase());
}

async function addPrecompressedArtifactFiles(files: ArtifactFile[], artifactPaths: Set<string>): Promise<PrecompressionStats> {
  const sourceFiles = [...files];
  const stats: PrecompressionStats = {
    br: 0,
    gzip: 0
  };

  for (const file of sourceFiles) {
    if (!shouldPrecompress(file)) {
      continue;
    }

    const bytes = await artifactFileBytes(file);
    const variants: ArtifactFile[] = [
      {
        relativePath: `${file.relativePath}.br`,
        bytes: brotliCompressSync(bytes),
        size: 0
      },
      {
        relativePath: `${file.relativePath}.gz`,
        bytes: gzipSync(bytes),
        size: 0
      }
    ];

    for (const variant of variants) {
      if (artifactPaths.has(variant.relativePath)) {
        continue;
      }

      files.push(variant);
      variant.size = variant.bytes?.byteLength ?? 0;
      artifactPaths.add(variant.relativePath);

      if (variant.relativePath.endsWith(".br")) {
        stats.br += 1;
      } else {
        stats.gzip += 1;
      }
    }
  }

  return stats;
}

const defaultArtifactPublisherDependencies: ArtifactPublisherDependencies = {
  randomUUID,
  writeFile
};

export function createArtifactPublisher(dependencies: Partial<ArtifactPublisherDependencies> = {}) {
  const resolvedDependencies: ArtifactPublisherDependencies = {
    ...defaultArtifactPublisherDependencies,
    ...dependencies
  };

  return (options: ArtifactPublishOptions) => publishBuildArtifactWithDependencies(options, resolvedDependencies);
}

export async function publishBuildArtifact(options: ArtifactPublishOptions): Promise<PublishedBuildArtifact> {
  return publishBuildArtifactWithDependencies(options, defaultArtifactPublisherDependencies);
}

async function publishBuildArtifactWithDependencies(
  options: ArtifactPublishOptions,
  dependencies: ArtifactPublisherDependencies
): Promise<PublishedBuildArtifact> {
  const outputDirectory = path.resolve(options.outputDirectory);
  const artifactRoot = path.resolve(options.artifactRoot);
  const entrypoint = safeArtifactPath(options.entrypoint ?? "index.html");
  const files: ArtifactFile[] = [];

  await collectArtifactFiles(outputDirectory, outputDirectory, files);

  if (files.length === 0) {
    throw new Error(`Build output directory is empty: ${options.outputDirectory}`);
  }

  if (!files.some((file) => file.relativePath === entrypoint)) {
    throw new Error(`Build output directory must contain ${entrypoint}.`);
  }

  const functions = (options.functions ?? []).map((entry): FunctionEntrypoint => {
    const next: FunctionEntrypoint = {
      path: entry.path,
      sourcePath: safeArtifactPath(entry.artifactPath),
      runtime: entry.runtime,
      runtimeIsolation: entry.runtimeIsolation ?? "same_process",
      handler: entry.handler ?? "default",
      apiStyle: entry.apiStyle ?? "fetch"
    };

    if (entry.methods && entry.methods.length > 0) {
      next.methods = entry.methods;
    }

    if (entry.timeoutMs !== undefined) {
      next.timeoutMs = entry.timeoutMs;
    }

    if (entry.memoryMb !== undefined) {
      next.memoryMb = entry.memoryMb;
    }

    if (entry.concurrency !== undefined) {
      next.concurrency = entry.concurrency;
    }

    if (entry.regions && entry.regions.length > 0) {
      next.regions = entry.regions;
    }

    if (entry.failoverRegions && entry.failoverRegions.length > 0) {
      next.failoverRegions = entry.failoverRegions;
    }

    return next;
  });
  const artifactPaths = new Set(files.map((file) => file.relativePath));

  for (const entry of options.functions ?? []) {
    const artifactPath = safeArtifactPath(entry.artifactPath);

    if (artifactPaths.has(artifactPath)) {
      throw new Error(`Function artifact path conflicts with static artifact: ${artifactPath}`);
    }

    const stats = await lstat(entry.sourcePath);

    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Function artifact source must be a regular file: ${artifactPath}.`);
    }

    files.push({
      relativePath: artifactPath,
      sourcePath: entry.sourcePath,
      size: stats.size
    });
    artifactPaths.add(artifactPath);
  }

  for (const entry of options.extraFiles ?? []) {
    const artifactPath = safeArtifactPath(entry.artifactPath);

    if (artifactPaths.has(artifactPath)) {
      throw new Error(`Extra artifact path conflicts with existing artifact: ${artifactPath}`);
    }

    const bytes = Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents, "utf8");
    files.push({
      relativePath: artifactPath,
      bytes,
      size: bytes.byteLength
    });
    artifactPaths.add(artifactPath);
  }

  await addClientEnvironmentShim(files, artifactPaths, options.clientEnvironmentVariables);

  assertArtifactBudget(files, options, "publish preflight");
  await assertNoBlockedContentValues(files, normalizedBlockedContentValues(options.blockedContentValues));
  await assertNoUnsafeSourceMaps(files);
  const precompressed = await addPrecompressedArtifactFiles(files, artifactPaths);
  assertArtifactBudget(files, options, "publish finalization");

  const deploymentId = `dep_${dependencies.randomUUID().replace(/-/g, "")}`;
  const targetRoot = path.join(artifactRoot, deploymentId);
  const stagingRoot = path.join(artifactRoot, `.publish-${deploymentId}-${dependencies.randomUUID().replace(/-/g, "")}`);
  const targetLockRoot = path.join(artifactRoot, `.publish-lock-${deploymentId}`);
  const checksum = createHash("sha256");
  let totalBytes = 0;
  let stagingCreated = false;
  let targetLockAcquired = false;
  let promoted = false;

  try {
    await mkdir(artifactRoot, { recursive: true });
    await assertDeploymentTargetAvailable(targetRoot);
    await mkdir(targetLockRoot);
    targetLockAcquired = true;
    await assertDeploymentTargetAvailable(targetRoot);
    await mkdir(stagingRoot);
    stagingCreated = true;

    for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
      const targetPath = path.resolve(stagingRoot, ...file.relativePath.split("/"));
      const bytes = await artifactFileBytes(file);

      if (!targetPath.startsWith(`${stagingRoot}${path.sep}`)) {
        throw new Error(`Artifact file escapes deployment root: ${file.relativePath}`);
      }

      await mkdir(path.dirname(targetPath), { recursive: true });
      await dependencies.writeFile(targetPath, bytes);

      checksum.update(file.relativePath);
      checksum.update("\0");
      checksum.update(bytes);
      totalBytes += bytes.byteLength;
    }

    await assertDeploymentTargetAvailable(targetRoot);
    await rename(stagingRoot, targetRoot);
    promoted = true;
  } catch (error) {
    if (stagingCreated && !promoted) {
      await rm(stagingRoot, { recursive: true, force: true });
    }

    throw error;
  } finally {
    if (targetLockAcquired) {
      await removeDirectoryBestEffort(targetLockRoot);
    }
  }

  const digest = checksum.digest("hex");

  return {
    deploymentId,
    artifactRoot: targetRoot,
    entrypoint,
    fileCount: files.length,
    totalBytes,
    checksum: digest,
    manifest: {
      entrypoint,
      fileCount: files.length,
      totalBytes,
      checksum: `sha256:${digest}`,
      generatedAt: new Date().toISOString(),
      functions,
      metadata: {
        buildJobId: options.buildJobId,
        sourceEventId: options.sourceEventId,
        precompressed,
        ...options.metadata
      }
    }
  };
}
