import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseReleasePostPromotionEvidenceCheckArgs,
  runReleasePostPromotionEvidenceCheck,
  runReleasePostPromotionEvidenceCheckCli
} from "./releasePostPromotionEvidenceCheck";
import type { ReleaseEvidenceBundleResult } from "./releaseEvidenceBundleCheck";

const now = () => new Date("2026-06-08T12:00:00.000Z");
const commitRef = "abc123def4567890";
const repository = "acme/siteflow";
const branch = "main";
const releaseEvidencePathLabel = "evidence/release-evidence.json";

async function writeJson(root: string, relativePath: string, value: unknown) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

  return filePath;
}

function releaseEvidenceBundle() {
  return {
    schemaVersion: "siteflow.releaseEvidence.v1",
    name: "siteflow-release-evidence-bundle",
    checkedAt: "2026-06-08T10:00:00.000Z",
    targetEnvironment: "production",
    release: {
      commitRef,
      repository,
      branch,
      targetEnvironment: "production",
      releaseTicket: "REL-2026-0608",
      operatorName: "release-operator"
    },
    artifactEvidence: {
      evidence: {
        selectedEvidence: {
          fileCount: 5,
          totalBytes: 4096
        }
      }
    }
  };
}

function deploymentDetail(overrides: Record<string, unknown> = {}) {
  return {
    project: {
      id: "project-acme-dashboard",
      name: "Acme Dashboard"
    },
    deployment: {
      id: "dep-production",
      projectId: "project-acme-dashboard",
      status: "ready",
      environment: "production",
      version: "2026.06.08"
    },
    lineage: {
      artifact: {
        manifest: {
          fileCount: 5,
          totalBytes: 4096
        }
      },
      routeRevision: {
        id: "route-production",
        channel: "production",
        deploymentId: "dep-production",
        status: "applied",
        releaseEvidence: {
          evidencePath: releaseEvidencePathLabel,
          checkedAt: "2026-06-08T10:05:00.000Z",
          status: "passed",
          commitRef,
          repository,
          branch,
          targetEnvironment: "production",
          releaseTicket: "REL-2026-0608",
          operatorName: "release-operator"
        }
      }
    },
    ...overrides
  };
}

function deploymentDetailWithFunctions(functions: Array<Record<string, unknown>>, manifestRuntimeIsolation?: string) {
  return deploymentDetail({
    lineage: {
      artifact: {
        manifest: {
          fileCount: 5,
          totalBytes: 4096,
          ...(manifestRuntimeIsolation ? { runtimeIsolation: manifestRuntimeIsolation } : {}),
          functions
        }
      },
      routeRevision: {
        id: "route-production",
        channel: "production",
        deploymentId: "dep-production",
        status: "applied",
        releaseEvidence: {
          evidencePath: releaseEvidencePathLabel,
          checkedAt: "2026-06-08T10:05:00.000Z",
          status: "passed",
          commitRef,
          repository,
          branch,
          targetEnvironment: "production",
          releaseTicket: "REL-2026-0608",
          operatorName: "release-operator"
        }
      }
    }
  });
}

function bundleCheck(status: "passed" | "blocked" = "passed"): ReleaseEvidenceBundleResult {
  return {
    name: "siteflow-release-evidence-bundle-check",
    status,
    checkedAt: "2026-06-08T10:03:00.000Z",
    evidencePath: releaseEvidencePathLabel,
    thresholds: {
      maxEvidenceAgeHours: 168,
      allowHostBuildException: false
    },
    selectedEvidence: {
      releaseCommitRef: commitRef,
      repository,
      branch,
      releaseGateStatus: "pass",
      dockerBuildRehearsalStatus: "passed",
      postgresRehearsalStatus: "passed",
      artifactEvidenceStatus: "passed",
      releaseImageDigest: `sha256:${"f".repeat(64)}`,
      sourceProviderEvidenceStatus: "passed",
      backupEvidenceStatus: "passed",
      observabilityEvidenceStatus: "passed",
      operatorAccessEvidenceStatus: "passed",
      nonSessionCredentialEvidenceStatus: "passed",
      ingressEvidenceStatus: "passed",
      upgradeRollbackDrillStatus: "passed"
    },
    checks: status === "passed"
      ? [{ name: "bundle_shape", status: "pass", message: "passed" }]
      : [{ name: "promotion_evidence", status: "fail", message: "blocked" }],
    exitCode: status === "passed" ? 0 : 1
  };
}

describe("releasePostPromotionEvidenceCheck", () => {
  it("passes when the production route stores matching release evidence metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-pass-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail(),
        deploymentId: "dep-production",
        projectId: "project-acme-dashboard",
        expectedEvidencePath: releaseEvidencePathLabel,
        readinessProbe: { statusCode: 200 },
        metricsProbe: { status: "passed" },
        evaluateBundle: () => bundleCheck(),
        now
      });

      expect(result.status).toBe("passed");
      expect(result.exitCode).toBe(0);
      expect(result.selectedEvidence).toMatchObject({
        deploymentId: "dep-production",
        projectId: "project-acme-dashboard",
        channel: "production",
        releaseCommitRef: commitRef,
        repository,
        branch,
        targetEnvironment: "production",
        routeRevisionId: "route-production",
        routeEvidenceStatus: "passed",
        routeEvidenceCheckedAt: "2026-06-08T10:05:00.000Z"
      });
      expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when the final release evidence bundle no longer passes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-bundle-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail(),
        evaluateBundle: () => bundleCheck("blocked"),
        now
      });
      const bundle = result.checks.find((check) => check.name === "release_evidence_bundle_passed");

      expect(result.status).toBe("blocked");
      expect(bundle).toMatchObject({
        status: "fail"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when route release evidence metadata is missing a bounded checkedAt timestamp", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-timestamp-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const detail = deploymentDetail({
        lineage: {
          artifact: {
            manifest: {
              fileCount: 5,
              totalBytes: 4096
            }
          },
          routeRevision: {
            id: "route-production",
            channel: "production",
            deploymentId: "dep-production",
            status: "applied",
            releaseEvidence: {
              evidencePath: releaseEvidencePathLabel,
              status: "passed",
              commitRef,
              repository,
              branch,
              targetEnvironment: "production",
              releaseTicket: "REL-2026-0608",
              operatorName: "release-operator"
            }
          }
        }
      });
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: detail,
        evaluateBundle: () => bundleCheck(),
        now
      });
      const timestamp = result.checks.find((check) => check.name === "route_release_evidence_timestamp");

      expect(result.status).toBe("blocked");
      expect(result.selectedEvidence.routeEvidenceCheckedAt).toBeNull();
      expect(timestamp).toMatchObject({
        status: "fail"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when route release evidence metadata was checked before the release bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-timestamp-before-bundle-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const detail = deploymentDetail();
      detail.lineage.routeRevision.releaseEvidence.checkedAt = "2026-06-08T09:59:59.000Z";

      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: detail,
        evaluateBundle: () => bundleCheck(),
        now
      });
      const timestamp = result.checks.find((check) => check.name === "route_release_evidence_timestamp");

      expect(result.status).toBe("blocked");
      expect(result.selectedEvidence.routeEvidenceCheckedAt).toBe("2026-06-08T09:59:59.000Z");
      expect(timestamp).toMatchObject({
        status: "fail",
        details: {
          releaseEvidenceCheckedAt: "2026-06-08T10:00:00.000Z",
          routeReleaseEvidenceCheckedAt: "2026-06-08T09:59:59.000Z",
          checkedAt: "2026-06-08T12:00:00.000Z"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when route release evidence metadata is checked after the post-promotion check", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-timestamp-after-check-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const detail = deploymentDetail();
      detail.lineage.routeRevision.releaseEvidence.checkedAt = "2026-06-08T12:00:01.000Z";

      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: detail,
        evaluateBundle: () => bundleCheck(),
        now
      });
      const timestamp = result.checks.find((check) => check.name === "route_release_evidence_timestamp");

      expect(result.status).toBe("blocked");
      expect(result.selectedEvidence.routeEvidenceCheckedAt).toBe("2026-06-08T12:00:01.000Z");
      expect(timestamp).toMatchObject({
        status: "fail",
        details: {
          releaseEvidenceCheckedAt: "2026-06-08T10:00:00.000Z",
          routeReleaseEvidenceCheckedAt: "2026-06-08T12:00:01.000Z",
          checkedAt: "2026-06-08T12:00:00.000Z"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when the promoted deployment manifest has functions missing runtime isolation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-function-missing-isolation-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetailWithFunctions([
          {
            path: "/api/revalidate",
            sourcePath: ".siteflow/functions/api/revalidate.js",
            runtime: "nodejs20.x",
            handler: "default"
          }
        ]),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const runtimeIsolation = result.checks.find((check) => check.name === "artifact_function_runtime_isolation");

      expect(result.status).toBe("blocked");
      expect(runtimeIsolation).toMatchObject({
        status: "fail",
        details: {
          functionCount: 1,
          blockedFunctions: [
            {
              path: "/api/revalidate",
              runtimeIsolation: null,
              reason: "missing runtime isolation"
            }
          ]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when the promoted deployment manifest declares same-process function isolation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-function-same-process-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetailWithFunctions([
          {
            path: "/api/revalidate",
            sourcePath: ".siteflow/functions/api/revalidate.js",
            runtime: "nodejs20.x",
            runtimeIsolation: "same_process",
            handler: "default"
          }
        ]),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const runtimeIsolation = result.checks.find((check) => check.name === "artifact_function_runtime_isolation");

      expect(result.status).toBe("blocked");
      expect(runtimeIsolation).toMatchObject({
        status: "fail",
        details: {
          blockedFunctions: [
            {
              path: "/api/revalidate",
              runtimeIsolation: "same_process",
              reason: "unsupported runtime isolation"
            }
          ]
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes when promoted deployment functions declare isolated runtime isolation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-function-isolated-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetailWithFunctions([
          {
            path: "/api/revalidate",
            sourcePath: ".siteflow/functions/api/revalidate.js",
            runtime: "nodejs20.x",
            runtimeIsolation: "isolated_process",
            handler: "default"
          }
        ]),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const runtimeIsolation = result.checks.find((check) => check.name === "artifact_function_runtime_isolation");

      expect(result.status).toBe("passed");
      expect(runtimeIsolation).toMatchObject({
        status: "pass"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when route release evidence metadata does not match the bundle identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-mismatch-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const detail = deploymentDetail({
        lineage: {
          artifact: {
            manifest: {
              fileCount: 5,
              totalBytes: 4096
            }
          },
          routeRevision: {
            id: "route-production",
            channel: "production",
            deploymentId: "dep-production",
            status: "applied",
            releaseEvidence: {
              evidencePath: releaseEvidencePathLabel,
              checkedAt: "2026-06-08T10:05:00.000Z",
              status: "passed",
              commitRef: "different",
              repository,
              branch,
              targetEnvironment: "production"
            }
          }
        }
      });
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: detail,
        evaluateBundle: () => bundleCheck(),
        now
      });
      const identity = result.checks.find((check) => check.name === "route_release_evidence_identity");

      expect(result.status).toBe("blocked");
      expect(identity).toMatchObject({
        status: "fail"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fetches deployment detail from the SiteFlow API when server and deployment are provided", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-fetch-"));
    const requests: Array<{ url: string; authorization: string }> = [];

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        serverUrl: "https://siteflow.example.com/",
        apiToken: "api-token",
        deploymentId: "dep-production",
        projectId: "project-acme-dashboard",
        expectedEvidencePath: releaseEvidencePathLabel,
        fetch: async (input, init) => {
          requests.push({
            url: input.toString(),
            authorization: new Headers(init?.headers).get("authorization") ?? ""
          });

          return new Response(JSON.stringify(deploymentDetail()), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        },
        evaluateBundle: () => bundleCheck(),
        now
      });

      expect(result.status).toBe("passed");
      expect(requests).toEqual([
        {
          url: "https://siteflow.example.com/api/deployments/dep-production",
          authorization: "Bearer api-token"
        }
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("parses CLI arguments and reports usage errors", async () => {
    expect(parseReleasePostPromotionEvidenceCheckArgs([
      "--release-evidence", "release.json",
      "--deployment-detail", "deployment.json",
      "--deployment", "dep-production",
      "--project", "project-acme-dashboard",
      "--expected-evidence-path", releaseEvidencePathLabel,
      "--json"
    ])).toEqual({
      releaseEvidencePath: "release.json",
      deploymentDetailPath: "deployment.json",
      deploymentId: "dep-production",
      projectId: "project-acme-dashboard",
      expectedEvidencePath: releaseEvidencePathLabel,
      json: true,
      help: false
    });

    let stderr = "";
    const exitCode = await runReleasePostPromotionEvidenceCheckCli([], {
      stdout: { write: () => true },
      stderr: { write: (value: string) => { stderr += value; return true; } }
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--release-evidence is required");
    expect(stderr).toContain("release:evidence:post-promote");
  });
});
