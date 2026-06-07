export type SiteFlowTopology = "single" | "control-plane" | "worker";
export type SiteFlowStorageMode = "local" | "s3";
export type SiteFlowDatabaseMode = "bundled" | "external";
export type SiteFlowRouterMode = "managed-nginx" | "external" | "none";
export type SiteFlowTlsMode = "letsencrypt" | "provided" | "none";

export interface InstallPaths {
  installDir: string;
  configDir: string;
  dataDir: string;
  backupDir: string;
}

export interface InstallState {
  schemaVersion: 1;
  siteflowVersion: string;
  installedAt: string;
  topology: SiteFlowTopology;
  paths: InstallPaths;
  database: {
    mode: SiteFlowDatabaseMode;
    schemaVersion: number;
    secretRef?: string;
  };
  storage: {
    mode: SiteFlowStorageMode;
    artifactRoot?: string;
    bucket?: string;
  };
  router: {
    mode: SiteFlowRouterMode;
    activeRevision?: string;
    previousKnownGoodRevision?: string | null;
    controlPlaneHost?: string;
    wildcardBaseDomain?: string;
    previewHostPattern?: string;
    nginxConfigPath?: string;
    nginxAvailablePath?: string;
    nginxEnabledPath?: string;
  };
  tls: {
    mode: SiteFlowTlsMode;
    domains: string[];
  };
  services: {
    manager: "systemd" | "compose";
    unit?: string;
    unitPath?: string;
    composeFile: string;
  };
  secrets: {
    apiTokenRef: string;
    postgresPasswordRef: string;
    appSecretRef: string;
    workerTokenRef: string;
  };
  checksums: Record<string, string>;
  lastOperation?: {
    id: string;
    type: string;
    status: "planned" | "running" | "succeeded" | "failed";
  };
}

export function defaultInstallPaths(): InstallPaths {
  return {
    installDir: "/opt/siteflow",
    configDir: "/etc/siteflow",
    dataDir: "/var/lib/siteflow",
    backupDir: "/var/backups/siteflow"
  };
}

export interface CreateInstallStateInput {
  siteflowVersion: string;
  topology?: SiteFlowTopology;
  domain?: string;
  baseDomain?: string;
  paths?: Partial<InstallPaths>;
  installedAt?: string;
}

function uniqueValues(values: Array<string | undefined>) {
  return values.filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
}

export function createInitialInstallState(input: CreateInstallStateInput): InstallState {
  const paths = {
    ...defaultInstallPaths(),
    ...input.paths
  };

  return {
    schemaVersion: 1,
    siteflowVersion: input.siteflowVersion,
    installedAt: input.installedAt ?? new Date().toISOString(),
    topology: input.topology ?? "single",
    paths,
    database: {
      mode: "bundled",
      schemaVersion: 0,
      secretRef: `${paths.configDir}/secrets/postgres-password.secret`
    },
    storage: {
      mode: "local",
      artifactRoot: `${paths.dataDir}/artifacts`
    },
    router: {
      mode: "managed-nginx",
      previousKnownGoodRevision: null,
      controlPlaneHost: input.domain,
      wildcardBaseDomain: input.baseDomain,
      previewHostPattern: input.baseDomain ? `*.${input.baseDomain}` : undefined,
      nginxConfigPath: `${paths.configDir}/nginx/siteflow.conf`,
      nginxAvailablePath: "/etc/nginx/sites-available/siteflow.conf",
      nginxEnabledPath: "/etc/nginx/sites-enabled/siteflow.conf"
    },
    tls: {
      mode: input.domain || input.baseDomain ? "letsencrypt" : "none",
      domains: uniqueValues([input.domain, input.baseDomain ? `*.${input.baseDomain}` : undefined])
    },
    services: {
      manager: "systemd",
      unit: "siteflow.service",
      unitPath: "/etc/systemd/system/siteflow.service",
      composeFile: `${paths.installDir}/compose.yaml`
    },
    secrets: {
      apiTokenRef: `${paths.configDir}/secrets/api-token.secret`,
      postgresPasswordRef: `${paths.configDir}/secrets/postgres-password.secret`,
      appSecretRef: `${paths.configDir}/secrets/app-secret.secret`,
      workerTokenRef: `${paths.configDir}/secrets/worker-token.secret`
    },
    checksums: {},
    lastOperation: {
      id: "install-dry-run",
      type: "install",
      status: "planned"
    }
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseInstallState(value: unknown): InstallState {
  if (!isObject(value)) {
    throw new Error("Install state must be a JSON object.");
  }

  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported install state schema version.");
  }

  if (typeof value.siteflowVersion !== "string" || !value.siteflowVersion) {
    throw new Error("Install state requires siteflowVersion.");
  }

  if (value.topology !== "single" && value.topology !== "control-plane" && value.topology !== "worker") {
    throw new Error("Install state has an invalid topology.");
  }

  if (!isObject(value.paths)) {
    throw new Error("Install state requires paths.");
  }

  return value as unknown as InstallState;
}
