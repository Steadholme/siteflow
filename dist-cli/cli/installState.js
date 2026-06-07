export function defaultInstallPaths() {
    return {
        installDir: "/opt/siteflow",
        configDir: "/etc/siteflow",
        dataDir: "/var/lib/siteflow",
        backupDir: "/var/backups/siteflow"
    };
}
function uniqueValues(values) {
    return values.filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
}
export function createInitialInstallState(input) {
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
function isObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function parseInstallState(value) {
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
    return value;
}
