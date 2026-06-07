import { createHash, randomUUID } from "node:crypto";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactManifest, FunctionEntrypoint, SiteFlowId } from "../src/domain/siteflow.js";

export interface FunctionArtifactInput {
  path: string;
  sourcePath: string;
  artifactPath: string;
  runtime: FunctionEntrypoint["runtime"];
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

export interface ArtifactPublishOptions {
  buildJobId: SiteFlowId;
  sourceEventId: SiteFlowId;
  outputDirectory: string;
  artifactRoot: string;
  entrypoint?: string;
  functions?: FunctionArtifactInput[];
  extraFiles?: ArtifactExtraFileInput[];
  metadata?: Record<string, unknown>;
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
  bytes: Buffer;
}

interface PrecompressionStats {
  br: number;
  gzip: number;
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

async function collectArtifactFiles(root: string, current: string, files: ArtifactFile[]) {
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);

    if (entry.isDirectory()) {
      await collectArtifactFiles(root, fullPath, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push({
      relativePath: safeArtifactPath(toPosixPath(path.relative(root, fullPath))),
      bytes: await readFile(fullPath)
    });
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

function addPrecompressedArtifactFiles(files: ArtifactFile[], artifactPaths: Set<string>): PrecompressionStats {
  const sourceFiles = [...files];
  const stats: PrecompressionStats = {
    br: 0,
    gzip: 0
  };

  for (const file of sourceFiles) {
    if (!shouldPrecompress(file)) {
      continue;
    }

    const variants: ArtifactFile[] = [
      {
        relativePath: `${file.relativePath}.br`,
        bytes: brotliCompressSync(file.bytes)
      },
      {
        relativePath: `${file.relativePath}.gz`,
        bytes: gzipSync(file.bytes)
      }
    ];

    for (const variant of variants) {
      if (artifactPaths.has(variant.relativePath)) {
        continue;
      }

      files.push(variant);
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

export async function publishBuildArtifact(options: ArtifactPublishOptions): Promise<PublishedBuildArtifact> {
  const outputDirectory = path.resolve(options.outputDirectory);
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
      handler: entry.handler ?? "default"
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

    files.push({
      relativePath: artifactPath,
      bytes: await readFile(entry.sourcePath)
    });
    artifactPaths.add(artifactPath);
  }

  for (const entry of options.extraFiles ?? []) {
    const artifactPath = safeArtifactPath(entry.artifactPath);

    if (artifactPaths.has(artifactPath)) {
      throw new Error(`Extra artifact path conflicts with existing artifact: ${artifactPath}`);
    }

    files.push({
      relativePath: artifactPath,
      bytes: Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents, "utf8")
    });
    artifactPaths.add(artifactPath);
  }

  const precompressed = addPrecompressedArtifactFiles(files, artifactPaths);

  const deploymentId = `dep_${randomUUID().replace(/-/g, "")}`;
  const targetRoot = path.resolve(options.artifactRoot, deploymentId);
  const checksum = createHash("sha256");
  let totalBytes = 0;

  await mkdir(targetRoot, { recursive: true });

  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    const targetPath = path.resolve(targetRoot, ...file.relativePath.split("/"));

    if (!targetPath.startsWith(`${targetRoot}${path.sep}`)) {
      throw new Error(`Artifact file escapes deployment root: ${file.relativePath}`);
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, file.bytes);

    checksum.update(file.relativePath);
    checksum.update("\0");
    checksum.update(file.bytes);
    totalBytes += file.bytes.byteLength;
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
