import { normalizeDnsName, renderComposeFile, renderManagedNginxConfig, renderSiteFlowEnvFile, renderSystemdUnit } from "./installAssets.js";
import { createInitialInstallState } from "./installState.js";
function normalizeOptionalDomain(value, label) {
    return value ? normalizeDnsName(value, label) : undefined;
}
function normalizeApiPort(value) {
    const port = value ?? 8787;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("API port must be an integer between 1 and 65535.");
    }
    return port;
}
export function createSingleHostInstallPlan(input) {
    const topology = input.topology ?? "single";
    if (topology !== "single") {
        throw new Error(`Topology ${topology} is not implemented in the MVP installer.`);
    }
    const controlPlaneHost = normalizeOptionalDomain(input.domain, "Control-plane domain");
    const wildcardBaseDomain = normalizeOptionalDomain(input.baseDomain, "Wildcard base domain") ?? controlPlaneHost;
    const apiPort = normalizeApiPort(input.apiPort);
    const publicScheme = input.publicScheme ?? (controlPlaneHost || wildcardBaseDomain ? "https" : "http");
    const image = input.image ?? `ghcr.io/siteflow/siteflow:${input.version}`;
    const installState = createInitialInstallState({
        siteflowVersion: input.version,
        topology,
        domain: controlPlaneHost,
        baseDomain: wildcardBaseDomain
    });
    const runtimeEnv = {
        SITEFLOW_VERSION: input.version,
        SITEFLOW_IMAGE: image,
        SITEFLOW_API_PORT: String(apiPort),
        SITEFLOW_ARTIFACT_ROOT: installState.storage.artifactRoot ?? `${installState.paths.dataDir}/artifacts`,
        SITEFLOW_PUBLIC_SCHEME: publicScheme,
        ...(wildcardBaseDomain ? { SITEFLOW_BASE_DOMAIN: wildcardBaseDomain } : {})
    };
    const env = renderSiteFlowEnvFile({
        path: `${installState.paths.configDir}/siteflow.env`,
        apiPort,
        artifactRoot: runtimeEnv.SITEFLOW_ARTIFACT_ROOT,
        publicScheme,
        version: input.version,
        image,
        baseDomain: wildcardBaseDomain
    });
    const compose = renderComposeFile({
        path: installState.services.composeFile,
        apiPort,
        artifactRoot: runtimeEnv.SITEFLOW_ARTIFACT_ROOT,
        publicScheme,
        version: input.version,
        image,
        baseDomain: wildcardBaseDomain,
        dataDir: installState.paths.dataDir,
        configDir: installState.paths.configDir
    });
    const systemd = renderSystemdUnit({
        path: installState.services.unitPath,
        unitName: installState.services.unit,
        composeFile: installState.services.composeFile,
        workingDirectory: installState.paths.installDir
    });
    const secrets = [
        {
            id: "api-token",
            path: installState.secrets.apiTokenRef,
            description: "Bearer token used by CLI clients and deployment automation.",
            byteLength: 32
        },
        {
            id: "postgres-password",
            path: installState.secrets.postgresPasswordRef,
            description: "Password for the bundled Postgres siteflow user.",
            byteLength: 32
        },
        {
            id: "app-secret",
            path: installState.secrets.appSecretRef,
            description: "Internal application signing secret reserved for auth/session hardening.",
            byteLength: 32
        },
        {
            id: "worker-token",
            path: installState.secrets.workerTokenRef,
            description: "Internal worker registration token reserved for local build worker rollout.",
            byteLength: 32
        }
    ];
    const nginx = controlPlaneHost || wildcardBaseDomain
        ? renderManagedNginxConfig({
            path: installState.router.nginxConfigPath,
            controlPlaneHost,
            wildcardBaseDomain,
            apiPort
        })
        : undefined;
    installState.checksums = {
        env: env.checksum,
        compose: compose.checksum,
        systemd: systemd.checksum,
        ...(nginx ? { nginx: nginx.checksum } : {})
    };
    return {
        topology,
        dryRun: input.dryRun ?? true,
        installState,
        runtimeEnv,
        secrets,
        renderedAssets: {
            env,
            compose,
            systemd,
            ...(nginx ? { nginx } : {})
        },
        steps: [
            {
                id: "preflight",
                title: "Host preflight",
                action: "validate",
                summary: "Validate OS, CPU architecture, Docker, Nginx, ports, disk, clock, DNS, and TLS inputs."
            },
            {
                id: "directories",
                title: "Create directories and service user",
                action: "create",
                summary: "Create /opt/siteflow, /etc/siteflow, /var/lib/siteflow, /var/log/siteflow, and /var/backups/siteflow."
            },
            {
                id: "secrets",
                title: "Generate secret files",
                action: "create",
                summary: "Generate app, session, worker, webhook, bundled Postgres, and admin bootstrap secrets without printing raw values."
            },
            {
                id: "render-config",
                title: "Render service configuration",
                action: "render",
                summary: `Render Compose, env, systemd, and Nginx files to staging paths with checksums.${wildcardBaseDomain ? ` Preview hosts use *.${wildcardBaseDomain}.` : ""}`
            },
            {
                id: "database",
                title: "Start Postgres and run migrations",
                action: "migrate",
                summary: "Start bundled Postgres, acquire migration lock, and apply control-plane migrations."
            },
            {
                id: "services",
                title: "Start API and worker",
                action: "start",
                summary: "Start SiteFlow API and local Docker build worker under the siteflow service account."
            },
            {
                id: "artifacts",
                title: "Validate local artifact store",
                action: "verify",
                summary: "Write, read, and checksum a local artifact probe under /var/lib/siteflow/artifacts."
            },
            {
                id: "router",
                title: "Apply managed Nginx",
                action: "apply",
                summary: nginx
                    ? `Validate generated Nginx config for ${[controlPlaneHost, nginx.previewHostPattern].filter(Boolean).join(" and ")}, swap it into sites-enabled, reload, and keep previous known-good config.`
                    : "Validate generated Nginx config, swap it into sites-enabled, reload, and keep previous known-good config."
            },
            {
                id: "tls",
                title: "Configure TLS",
                action: "apply",
                summary: wildcardBaseDomain
                    ? "Issue or validate TLS for the control-plane host and wildcard preview host. Wildcard Let's Encrypt requires DNS-01 support."
                    : "Issue Let's Encrypt certificate or validate provided certificate paths when TLS is enabled."
            },
            {
                id: "doctor",
                title: "Run final doctor",
                action: "verify",
                summary: "Run critical host, service, DB, storage, route, TLS, and secret-permission checks."
            },
            {
                id: "state",
                title: "Write install state",
                action: "write",
                summary: "Persist /etc/siteflow/install-state.json only after critical checks pass."
            }
        ]
    };
}
export function formatInstallPlan(plan) {
    const lines = [`SiteFlow install plan (${plan.topology}, dry-run)`];
    for (const [index, step] of plan.steps.entries()) {
        lines.push(`${index + 1}. ${step.title} [${step.action}]`);
        lines.push(`   ${step.summary}`);
    }
    return lines.join("\n");
}
