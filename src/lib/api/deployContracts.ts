export interface PrebuiltDeployFile {
  path: string;
  contentBase64: string;
  size: number;
  sha256: string;
}

export interface PrebuiltUploadBudget {
  maxUploadBytes?: number;
  maxFiles?: number;
}

export interface PrebuiltUploadStats {
  fileCount: number;
  totalBytes: number;
}

export const defaultPrebuiltMaxUploadBytes = 536870912;
export const defaultPrebuiltMaxUploadFiles = 20000;

function base64DecodedByteLength(value: string) {
  const normalized = value.trim();

  if (!normalized) {
    return 0;
  }

  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return undefined;
  }

  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor(normalized.length * 3 / 4) - padding;
}

function positiveBudgetValue(value: number | undefined) {
  return Number.isInteger(value) && value !== undefined && value > 0 ? value : undefined;
}

export function prebuiltUploadStats(files: PrebuiltDeployFile[]): PrebuiltUploadStats {
  return {
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.size, 0)
  };
}

export function assertPrebuiltUploadBudget(
  files: PrebuiltDeployFile[],
  budget: PrebuiltUploadBudget,
  label = "Prebuilt upload"
) {
  const maxFiles = positiveBudgetValue(budget.maxFiles);
  const maxUploadBytes = positiveBudgetValue(budget.maxUploadBytes);

  if (maxFiles !== undefined && files.length > maxFiles) {
    throw new Error(`${label} exceeds SITEFLOW_PREBUILT_MAX_FILES: ${files.length} > ${maxFiles}.`);
  }

  let totalBytes = 0;

  for (const file of files) {
    const decodedBytes = base64DecodedByteLength(file.contentBase64);

    if (decodedBytes === undefined) {
      throw new Error(`${label} file ${file.path} contentBase64 must be valid base64.`);
    }

    if (decodedBytes !== file.size) {
      throw new Error(`${label} file ${file.path} size does not match decoded content: ${file.size} !== ${decodedBytes}.`);
    }

    totalBytes += decodedBytes;
  }

  if (maxUploadBytes !== undefined && totalBytes > maxUploadBytes) {
    throw new Error(`${label} exceeds SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: ${totalBytes} > ${maxUploadBytes}.`);
  }

  return {
    fileCount: files.length,
    totalBytes
  };
}

export interface PrebuiltRoutingHeader {
  key: string;
  value: string;
}

export interface PrebuiltRoutingRule {
  name?: string;
  source: string;
  destination?: string;
  statusCode?: 301 | 302 | 307 | 308;
  headers?: PrebuiltRoutingHeader[];
}

export interface PrebuiltRoutingConfig {
  redirects?: PrebuiltRoutingRule[];
  rewrites?: PrebuiltRoutingRule[];
  headers?: PrebuiltRoutingRule[];
  cleanUrls?: boolean;
  trailingSlash?: boolean;
  skipTrailingSlashRedirect?: boolean;
}

export interface PrebuiltCronJob {
  path: string;
  schedule: string;
}

export interface PrebuiltImageConfig {
  sizes?: number[];
  qualities?: number[];
  formats?: Array<"image/avif" | "image/webp">;
  minimumCacheTTL?: number;
  dangerouslyAllowSVG?: boolean;
  contentSecurityPolicy?: string;
  contentDispositionType?: "inline" | "attachment";
}

export interface PrebuiltReleaseEvidenceMetadata {
  evidencePath: string;
  checkedAt: string;
  status: "passed";
  commitRef: string;
  repository: string;
  branch: string;
  targetEnvironment: string;
  releaseTicket?: string;
  operatorName?: string;
}

export interface PrebuiltReleaseEvidenceBundleRequest {
  evidencePath: string;
  bundle: Record<string, unknown>;
}

export interface PrebuiltDeployCommand {
  projectSlug: string;
  baseDomain?: string;
  files: PrebuiltDeployFile[];
  entrypoint?: string;
  requestedHostPrefix?: string;
  public?: boolean;
  fluid?: boolean | null;
  images?: PrebuiltImageConfig;
  routing?: PrebuiltRoutingConfig;
  crons?: PrebuiltCronJob[];
  source?: {
    repository?: string;
    branch?: string;
    commitSha?: string;
  };
  releaseEvidence?: PrebuiltReleaseEvidenceMetadata | PrebuiltReleaseEvidenceBundleRequest;
}

export interface PrebuiltDeployResult {
  deploymentId: string;
  projectId: string;
  projectSlug: string;
  previewHost: string;
  previewUrl: string;
  artifactRoot: string;
  fileCount: number;
  totalBytes: number;
  checksum: string;
}
