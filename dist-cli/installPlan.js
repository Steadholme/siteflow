import { createInitialInstallState } from "./installState.js";
export function createSingleHostInstallPlan(input) {
    const topology = input.topology ?? "single";
    if (topology !== "single") {
        throw new Error(`Topology ${topology} is not implemented in the MVP installer.`);
    }
    return {
        topology,
        dryRun: true,
        installState: createInitialInstallState({
            siteflowVersion: input.version,
            topology,
            domain: input.domain
        }),
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
                summary: "Render Compose, env, systemd, and Nginx files to staging paths with checksums."
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
                summary: "Validate generated Nginx config, swap it into sites-enabled, reload, and keep previous known-good config."
            },
            {
                id: "tls",
                title: "Configure TLS",
                action: "apply",
                summary: "Issue Let's Encrypt certificate or validate provided certificate paths when TLS is enabled."
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
