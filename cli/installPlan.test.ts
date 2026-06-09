import { createSingleHostInstallPlan } from "./installPlan";

const runtimeImage = `ghcr.io/siteflow/siteflow@sha256:${"a".repeat(64)}`;
const postgresImage = `postgres@sha256:${"b".repeat(64)}`;
const buildImage = `node:20-bookworm-slim@sha256:${"c".repeat(64)}`;

describe("install plan", () => {
  it("plans production metrics and digest-pinned Docker images", () => {
    const plan = createSingleHostInstallPlan({
      domain: "siteflow.w33d.xyz",
      baseDomain: "w33d.xyz",
      image: runtimeImage,
      postgresImage,
      buildImage,
      dockerSocketGid: "998",
      version: "0.1.0-test"
    });

    expect(plan.runtimeEnv).toMatchObject({
      SITEFLOW_ENV: "production",
      SITEFLOW_IMAGE: runtimeImage,
      SITEFLOW_POSTGRES_IMAGE: postgresImage,
      SITEFLOW_TRUST_PROXY: "",
      SITEFLOW_WORKER_USER: "1000:1000",
      SITEFLOW_DOCKER_SOCKET_GID: "998",
      SITEFLOW_BUILD_RUNNER: "docker",
      SITEFLOW_BUILD_NETWORK: "none",
      SITEFLOW_BUILD_MAX_ARTIFACT_BYTES: "536870912",
      SITEFLOW_BUILD_MAX_ARTIFACT_FILES: "20000",
      SITEFLOW_BUILD_MIN_FREE_BYTES: "1073741824",
      SITEFLOW_BUILD_STEP_TIMEOUT_MS: "900000",
      SITEFLOW_GIT_TIMEOUT_MS: "300000",
      SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES: "536870912",
      SITEFLOW_PREBUILT_MAX_FILES: "20000",
      SITEFLOW_BUILD_IMAGE: buildImage
    });
    expect(plan.runtimeEnv).not.toHaveProperty("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
    expect(plan.runtimeEnv).not.toHaveProperty("SITEFLOW_METRICS_TOKEN");
    expect(plan.installState.worker).toMatchObject({
      buildRunner: "docker",
      buildImage,
      buildImageAllowlist: [],
      buildNetwork: "none",
      pollIntervalMs: 5000
    });
    expect(plan.installState.secrets.metricsTokenRef).toBe("/etc/siteflow/secrets/metrics-token.secret");
    expect(plan.installState.secrets.releaseEvidenceSigningKeyRef).toBe("/etc/siteflow/secrets/release-evidence-signing-key.secret");
    expect(plan.secrets.map((secret) => secret.id)).toEqual(
      expect.arrayContaining(["metrics-token", "release-evidence-signing-key", "api-token", "postgres-password", "app-secret", "worker-token"])
    );
    expect(plan.renderedAssets.compose.content).toContain("SITEFLOW_METRICS_TOKEN_FILE: /run/secrets/siteflow_metrics_token");
    expect(plan.renderedAssets.compose.content).toContain("SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY_FILE: /run/secrets/siteflow_release_evidence_signing_key");
    expect(plan.renderedAssets.compose.content).toContain("fetch('http://127.0.0.1:8787/readyz')");
    expect(plan.renderedAssets.compose.content).toContain('SITEFLOW_EVIDENCE_ROOT: "/var/lib/siteflow/evidence"');
    expect(plan.renderedAssets.compose.content).toContain('SITEFLOW_TRUST_PROXY: ""');
    expect(plan.renderedAssets.compose.content).toContain('SITEFLOW_GIT_SSH_KEY_PATH: "${SITEFLOW_GIT_SSH_KEY_PATH:-}"');
    expect(plan.renderedAssets.compose.content).toContain('SITEFLOW_GIT_KNOWN_HOSTS_PATH: "${SITEFLOW_GIT_KNOWN_HOSTS_PATH:-}"');
    expect(plan.renderedAssets.compose.content).toContain('    user: "${SITEFLOW_WORKER_USER:-1000:1000}"');
    expect(plan.renderedAssets.compose.content).toContain("    group_add:");
    expect(plan.renderedAssets.compose.content).toContain('      - "${SITEFLOW_DOCKER_SOCKET_GID:?SITEFLOW_DOCKER_SOCKET_GID must match /var/run/docker.sock group id}"');
    expect(plan.renderedAssets.compose.content).toContain("requires access to the trusted single-host Docker socket");
    expect(plan.renderedAssets.compose.content).toContain('DATABASE_URL: "postgres://siteflow@postgres:5432/siteflow"');
    expect(plan.renderedAssets.compose.content).not.toContain("export SITEFLOW_");
    expect(plan.renderedAssets.compose.content).not.toContain("$(cat /run/secrets/");
    expect(plan.renderedAssets.compose.content).toContain(`image: ${runtimeImage}`);
    expect(plan.renderedAssets.compose.content).toContain(`image: ${postgresImage}`);
    expect(plan.renderedAssets.compose.content).toContain(`SITEFLOW_BUILD_IMAGE: "${buildImage}"`);
    expect(plan.renderedAssets.compose.content).not.toContain("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
  });

  it("supports digest-pinned production build images without an allowlist", () => {
    const customBuildImage = "registry.example.com/siteflow/build-node@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const plan = createSingleHostInstallPlan({
      domain: "siteflow.w33d.xyz",
      baseDomain: "w33d.xyz",
      version: "0.1.0-test",
      image: runtimeImage,
      postgresImage,
      dockerSocketGid: "998",
      buildImage: customBuildImage
    });

    expect(plan.runtimeEnv.SITEFLOW_BUILD_IMAGE).toBe(customBuildImage);
    expect(plan.runtimeEnv).not.toHaveProperty("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
    expect(plan.installState.worker.buildImage).toBe(customBuildImage);
    expect(plan.installState.worker.buildImageAllowlist).toEqual([]);
    expect(plan.renderedAssets.env.content).toContain(`SITEFLOW_BUILD_IMAGE=${customBuildImage}`);
    expect(plan.renderedAssets.env.content).not.toContain("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
    expect(plan.renderedAssets.compose.content).toContain(`SITEFLOW_BUILD_IMAGE: "${customBuildImage}"`);
    expect(plan.renderedAssets.compose.content).not.toContain("SITEFLOW_BUILD_IMAGE_ALLOWLIST");
  });

  it("rejects unpinned production install images", () => {
    expect(() =>
      createSingleHostInstallPlan({
        domain: "siteflow.w33d.xyz",
        baseDomain: "w33d.xyz",
        version: "0.1.0-test",
        image: "ghcr.io/siteflow/siteflow:0.1.0-test",
        postgresImage,
        dockerSocketGid: "998",
        buildImage
      })
    ).toThrow("SITEFLOW_IMAGE must be pinned");

    expect(() =>
      createSingleHostInstallPlan({
        domain: "siteflow.w33d.xyz",
        baseDomain: "w33d.xyz",
        version: "0.1.0-test",
        image: runtimeImage,
        postgresImage: "postgres:16-alpine",
        dockerSocketGid: "998",
        buildImage
      })
    ).toThrow("SITEFLOW_POSTGRES_IMAGE must be pinned");

    expect(() =>
      createSingleHostInstallPlan({
        domain: "siteflow.w33d.xyz",
        baseDomain: "w33d.xyz",
        version: "0.1.0-test",
        image: runtimeImage,
        postgresImage,
        dockerSocketGid: "998",
        buildImage: "node:20-bookworm-slim"
      })
    ).toThrow("SITEFLOW_BUILD_IMAGE must be pinned");
  });

  it("requires explicit Docker socket GID and non-root worker user", () => {
    expect(() =>
      createSingleHostInstallPlan({
        domain: "siteflow.w33d.xyz",
        baseDomain: "w33d.xyz",
        version: "0.1.0-test",
        image: runtimeImage,
        postgresImage,
        buildImage
      })
    ).toThrow("SITEFLOW_DOCKER_SOCKET_GID is required");

    expect(() =>
      createSingleHostInstallPlan({
        domain: "siteflow.w33d.xyz",
        baseDomain: "w33d.xyz",
        version: "0.1.0-test",
        image: runtimeImage,
        postgresImage,
        buildImage,
        dockerSocketGid: "998",
        workerUser: "0:0"
      })
    ).toThrow("SITEFLOW_WORKER_USER must be a non-root");
  });
});
