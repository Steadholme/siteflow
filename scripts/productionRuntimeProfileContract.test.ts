import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function readRepoFile(relativePath: string) {
  return readFile(path.join(process.cwd(), relativePath), "utf8");
}

function serviceBlock(compose: string, serviceName: string) {
  const start = compose.indexOf(`  ${serviceName}:\n`);

  expect(start, `${serviceName} service must exist`).toBeGreaterThanOrEqual(0);

  const nextService = compose.slice(start + 1).search(/\n  [a-zA-Z0-9_-]+:\n/);

  return nextService >= 0 ? compose.slice(start, start + 1 + nextService) : compose.slice(start);
}

describe("production runtime profile contract", () => {
  it("keeps the runtime Docker image focused on compiled production entrypoints", async () => {
    const dockerfile = await readRepoFile("Dockerfile");

    expect(dockerfile).toContain("FROM node:20-bookworm-slim AS build");
    expect(dockerfile).toContain("FROM node:20-bookworm-slim AS runtime");
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).toContain("COPY --from=build /app/dist-server ./dist-server");
    expect(dockerfile).toContain("COPY --from=build /app/dist-worker ./dist-worker");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('CMD ["node", "dist-server/server/index.js"]');
  });

  it("requires digest-pinned production images without compose build fallbacks", async () => {
    const compose = await readRepoFile("docker-compose.production.yml");
    const postgres = serviceBlock(compose, "postgres");
    const api = serviceBlock(compose, "api");
    const worker = serviceBlock(compose, "worker");

    expect(compose).not.toMatch(/^\s+build:/m);
    expect(postgres).toContain("${SITEFLOW_POSTGRES_IMAGE:?SITEFLOW_POSTGRES_IMAGE must be pinned by digest for production}");
    expect(api).toContain("${SITEFLOW_IMAGE:?SITEFLOW_IMAGE must be the digest-pinned release image for production}");
    expect(worker).toContain("${SITEFLOW_IMAGE:?SITEFLOW_IMAGE must be the digest-pinned release image for production}");
    expect(worker).toContain("${SITEFLOW_BUILD_IMAGE:?SITEFLOW_BUILD_IMAGE must be pinned for production Docker builds}");
  });

  it("keeps the API in a socket-free, loopback-bound, hardened runtime profile", async () => {
    const api = serviceBlock(await readRepoFile("docker-compose.production.yml"), "api");

    expect(api).toContain('user: "1000:1000"');
    expect(api).toContain("read_only: true");
    expect(api).toContain("cap_drop:");
    expect(api).toContain("- ALL");
    expect(api).toContain("no-new-privileges:true");
    expect(api).toContain('"${SITEFLOW_API_BIND:-127.0.0.1}:8787:8787"');
    expect(api).toContain("SITEFLOW_APP_SECRET_FILE: /run/secrets/siteflow_app_secret");
    expect(api).toContain("SITEFLOW_API_TOKEN_FILE: /run/secrets/siteflow_api_token");
    expect(api).toContain("SITEFLOW_METRICS_TOKEN_FILE: /run/secrets/siteflow_metrics_token");
    expect(api).toContain("SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE: /run/secrets/siteflow_release_evidence_signing_key");
    expect(api).toContain('SITEFLOW_TRUST_PROXY: "${SITEFLOW_TRUST_PROXY:-}"');
    expect(api).toContain("fetch('http://127.0.0.1:8787/readyz')");
    expect(api).not.toContain("/var/run/docker.sock");
    expect(api).not.toContain("${SITEFLOW_TRUST_PROXY:-loopback}");
  });

  it("keeps the worker explicitly in the trusted single-host Docker socket profile", async () => {
    const worker = serviceBlock(await readRepoFile("docker-compose.production.yml"), "worker");

    expect(worker).toContain('user: "${SITEFLOW_WORKER_USER:-1000:1000}"');
    expect(worker).toContain('"${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}"');
    expect(worker).toContain("read_only: true");
    expect(worker).toContain("cap_drop:");
    expect(worker).toContain("- ALL");
    expect(worker).toContain("no-new-privileges:true");
    expect(worker).toContain("SITEFLOW_BUILD_RUNNER: docker");
    expect(worker).toContain("SITEFLOW_BUILD_NETWORK: ${SITEFLOW_BUILD_NETWORK:-none}");
    expect(worker).toContain('SITEFLOW_GIT_SSH_KEY_PATH: "${SITEFLOW_GIT_SSH_KEY_PATH:-}"');
    expect(worker).toContain('SITEFLOW_GIT_KNOWN_HOSTS_PATH: "${SITEFLOW_GIT_KNOWN_HOSTS_PATH:-}"');
    expect(worker).toContain("command -v docker");
    expect(worker).toContain("docker info");
    expect(worker).toContain('"dist-worker/worker/index.js"');
    expect(worker).toContain('"--healthcheck"');
    expect(worker).toContain("source: /var/run/docker.sock");
    expect(worker).toContain("target: /var/run/docker.sock");
    expect(worker).toContain("Trusted single-host operator profile");
    expect(worker).toContain("host Docker daemon");
  });
});
