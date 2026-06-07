#!/usr/bin/env node
import { Pool } from "pg";
import { createSiteFlowServer } from "./httpServer.js";
import { runMigrations } from "./migrations.js";
import { PostgresSiteFlowReadRepository } from "./postgresReadRepository.js";
const databaseUrl = process.env.DATABASE_URL;
const port = Number(process.env.SITEFLOW_API_PORT ?? process.env.PORT ?? 8787);
const version = process.env.SITEFLOW_VERSION ?? "0.1.0";
const artifactRoot = process.env.SITEFLOW_ARTIFACT_ROOT ?? "/var/lib/siteflow/artifacts";
const publicScheme = process.env.SITEFLOW_PUBLIC_SCHEME === "http" ? "http" : "https";
const apiToken = process.env.SITEFLOW_API_TOKEN;
const baseDomain = process.env.SITEFLOW_BASE_DOMAIN;
const githubWebhookSecret = process.env.SITEFLOW_GITHUB_WEBHOOK_SECRET;
if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the SiteFlow control-plane API.");
}
const pool = new Pool({ connectionString: databaseUrl });
await runMigrations(pool);
const server = createSiteFlowServer({
    repository: new PostgresSiteFlowReadRepository(pool, {
        artifactRoot,
        publicScheme,
        baseDomain
    }),
    version,
    allowedOrigin: process.env.SITEFLOW_ALLOWED_ORIGIN,
    apiToken,
    baseDomain,
    githubWebhookSecret
});
server.listen(port, () => {
    process.stdout.write(`SiteFlow control-plane API listening on ${port}\n`);
});
async function shutdown() {
    server.close();
    await pool.end();
}
process.on("SIGINT", () => {
    void shutdown().then(() => {
        process.exitCode = 0;
    });
});
process.on("SIGTERM", () => {
    void shutdown().then(() => {
        process.exitCode = 0;
    });
});
