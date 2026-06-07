export interface PrebuiltDeployFile {
  path: string;
  contentBase64: string;
  size: number;
  sha256: string;
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
    branch?: string;
    commitSha?: string;
  };
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
