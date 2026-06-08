import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { SourceCheckout, SourceResolver, QueuedBuildJob } from "./buildWorker.js";

export interface LocalSourceResolverOptions {
  sourceRoot?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function localPathFromPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return undefined;
  }

  const localPath = payload.localPath;
  return typeof localPath === "string" && localPath.trim() ? localPath.trim() : undefined;
}

function assertInsideRoot(candidate: string, root: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);

  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Local source path escapes the configured source root.");
  }

  return resolvedCandidate;
}

function sourcePathFor(job: QueuedBuildJob, sourceRoot?: string) {
  const payloadPath = localPathFromPayload(job.repository.providerPayload);

  if (payloadPath) {
    const resolved = path.isAbsolute(payloadPath) ? path.resolve(payloadPath) : path.resolve(sourceRoot ?? process.cwd(), payloadPath);
    return sourceRoot ? assertInsideRoot(resolved, sourceRoot) : resolved;
  }

  if (!sourceRoot) {
    throw new Error("Local source resolver requires sourceRoot or repository.providerPayload.localPath.");
  }

  return assertInsideRoot(path.join(sourceRoot, job.repository.owner, job.repository.name), sourceRoot);
}

function shouldCopy(sourcePath: string) {
  const parts = sourcePath.split(path.sep);
  return !parts.includes(".git") && !parts.includes("node_modules");
}

export function workspaceJobRoot(workspaceRoot: string, jobId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) {
    throw new Error("Source checkout job id must be a safe path segment.");
  }

  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedJobRoot = path.resolve(resolvedWorkspaceRoot, jobId);

  if (!resolvedJobRoot.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)) {
    throw new Error("Source checkout job root escapes the workspace root.");
  }

  return resolvedJobRoot;
}

export class LocalSourceResolver implements SourceResolver {
  private readonly sourceRoot?: string;

  constructor(options: LocalSourceResolverOptions = {}) {
    this.sourceRoot = options.sourceRoot ? path.resolve(options.sourceRoot) : undefined;
  }

  async checkout(job: QueuedBuildJob, workspaceRoot: string): Promise<SourceCheckout> {
    const sourceDirectory = sourcePathFor(job, this.sourceRoot);
    const sourceStat = await stat(sourceDirectory);

    if (!sourceStat.isDirectory()) {
      throw new Error(`Local source path is not a directory: ${sourceDirectory}`);
    }

    const jobRoot = workspaceJobRoot(workspaceRoot, job.id);
    const checkoutRoot = path.join(jobRoot, "source");

    try {
      await rm(checkoutRoot, { recursive: true, force: true });
      await mkdir(path.dirname(checkoutRoot), { recursive: true });
      await cp(sourceDirectory, checkoutRoot, {
        recursive: true,
        force: true,
        filter: shouldCopy
      });
    } catch (error) {
      await rm(jobRoot, { recursive: true, force: true });
      throw error;
    }

    return {
      sourceDirectory: checkoutRoot,
      cleanup: async () => {
        await rm(jobRoot, { recursive: true, force: true });
      }
    };
  }
}
