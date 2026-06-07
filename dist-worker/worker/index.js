#!/usr/bin/env node
import { Pool } from "pg";
import { runMigrations } from "../server/migrations.js";
import { LocalSourceResolver } from "./localSourceResolver.js";
import { PostgresBuildQueue } from "./postgresBuildQueue.js";
import { runBuildWorkerOnce } from "./buildWorker.js";
const databaseUrl = process.env.DATABASE_URL;
const artifactRoot = process.env.SITEFLOW_ARTIFACT_ROOT ?? "/var/lib/siteflow/artifacts";
const baseDomain = process.env.SITEFLOW_BASE_DOMAIN;
const publicScheme = process.env.SITEFLOW_PUBLIC_SCHEME === "http" ? "http" : "https";
const sourceRoot = process.env.SITEFLOW_SOURCE_ROOT;
const workerId = process.env.SITEFLOW_WORKER_ID ?? `worker-${process.pid}`;
if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to start the SiteFlow build worker.");
}
if (!baseDomain) {
    throw new Error("SITEFLOW_BASE_DOMAIN is required to publish preview build routes.");
}
const pool = new Pool({ connectionString: databaseUrl });
try {
    await runMigrations(pool);
    const result = await runBuildWorkerOnce({
        workerId,
        queue: new PostgresBuildQueue(pool),
        sourceResolver: new LocalSourceResolver({ sourceRoot }),
        artifactRoot,
        baseDomain,
        publicScheme
    });
    if (result) {
        process.stdout.write(`SiteFlow build completed: ${result.previewUrl}\n`);
    }
    else {
        process.stdout.write("SiteFlow build worker found no queued jobs.\n");
    }
}
finally {
    await pool.end();
}
