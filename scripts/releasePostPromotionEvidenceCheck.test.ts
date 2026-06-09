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
const artifactChecksum = `sha256:${"a".repeat(64)}`;
const payloadDigest = `sha256:${"d".repeat(64)}`;

async function writeJson(root: string, relativePath: string, value: unknown) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");

  return filePath;
}

function releaseEvidenceBundle(targetEnvironment = "production") {
  return {
    schemaVersion: "siteflow.releaseEvidence.v1",
    name: "siteflow-release-evidence-bundle",
    checkedAt: "2026-06-08T10:00:00.000Z",
    targetEnvironment,
    release: {
      commitRef,
      repository,
      branch,
      targetEnvironment,
      releaseTicket: "REL-2026-0608",
      operatorName: "release-operator"
    },
    artifactEvidence: {
      evidence: {
        selectedEvidence: {
          fileCount: 5,
          totalBytes: 4096,
          checksum: artifactChecksum
        }
      }
    }
  };
}

function deploymentDetail(overrides: Record<string, unknown> = {}, targetEnvironment = "production") {
  return {
    project: {
      id: "project-acme-dashboard",
      name: "Acme Dashboard"
    },
    deployment: {
      id: "dep-production",
      projectId: "project-acme-dashboard",
      status: "ready",
      environment: targetEnvironment,
      version: "2026.06.08"
    },
    lineage: {
      artifact: {
        manifest: {
          fileCount: 5,
          totalBytes: 4096,
          checksum: artifactChecksum
        }
      },
      routeRevision: {
        id: "route-production",
        channel: targetEnvironment,
        deploymentId: "dep-production",
        status: "applied",
        releaseEvidence: {
          evidencePath: releaseEvidencePathLabel,
          checkedAt: "2026-06-08T10:05:00.000Z",
          payloadDigest,
          status: "passed",
          commitRef,
          repository,
          branch,
          targetEnvironment,
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
          checksum: artifactChecksum,
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
          payloadDigest,
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
    payloadDigest,
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

function passingReadinessProbe() {
  return {
    endpoint: "/readyz",
    statusCode: 200,
    checkedAt: "2026-06-08T11:59:00.000Z"
  };
}

function passingMetricsProbe() {
  return {
    endpoint: "/metrics",
    statusCode: 200,
    checkedAt: "2026-06-08T11:59:00.000Z"
  };
}

function acceptedProductionProbeException(overrides: Record<string, unknown> = {}) {
  return {
    status: "accepted",
    targetEnvironment: "production",
    channel: "production",
    ticket: "INC-2026-0608",
    reason: "Target probe collector outage; production traffic remains held under incident control.",
    approvedBy: "release-manager",
    expiresAt: "2026-06-08T13:00:00.000Z",
    release: {
      commitRef,
      repository,
      branch,
      targetEnvironment: "production"
    },
    deployment: {
      id: "dep-production",
      projectId: "project-acme-dashboard",
      environment: "production"
    },
    project: {
      id: "project-acme-dashboard"
    },
    ...overrides
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
        readinessProbe: passingReadinessProbe(),
        metricsProbe: passingMetricsProbe(),
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
        routeEvidenceCheckedAt: "2026-06-08T10:05:00.000Z",
        routeEvidencePayloadDigest: payloadDigest
      });
      expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when route release evidence metadata omits payloadDigest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-missing-digest-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const detail = deploymentDetail();
      delete (detail.lineage.routeRevision.releaseEvidence as Record<string, unknown>).payloadDigest;

      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: detail,
        readinessProbe: passingReadinessProbe(),
        metricsProbe: passingMetricsProbe(),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const digest = result.checks.find((check) => check.name === "route_release_evidence_payload_digest");

      expect(result.status).toBe("blocked");
      expect(result.selectedEvidence.routeEvidencePayloadDigest).toBeNull();
      expect(digest).toMatchObject({
        status: "fail",
        details: {
          expectedPayloadDigest: payloadDigest,
          actualPayloadDigest: null
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when route release evidence metadata payloadDigest differs from the checked bundle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-wrong-digest-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const detail = deploymentDetail();
      detail.lineage.routeRevision.releaseEvidence.payloadDigest = `sha256:${"e".repeat(64)}`;

      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: detail,
        readinessProbe: passingReadinessProbe(),
        metricsProbe: passingMetricsProbe(),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const digest = result.checks.find((check) => check.name === "route_release_evidence_payload_digest");

      expect(result.status).toBe("blocked");
      expect(result.selectedEvidence.routeEvidencePayloadDigest).toBe(`sha256:${"e".repeat(64)}`);
      expect(digest).toMatchObject({
        status: "fail",
        details: {
          expectedPayloadDigest: payloadDigest,
          actualPayloadDigest: `sha256:${"e".repeat(64)}`
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production by default when readiness and metrics probes are missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-missing-probes-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail(),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const readinessRequired = result.checks.find((check) => check.name === "production_readiness_probe_required");
      const metricsRequired = result.checks.find((check) => check.name === "production_metrics_probe_required");
      const exception = result.checks.find((check) => check.name === "production_probe_exception");

      expect(result.status).toBe("blocked");
      expect(readinessRequired).toMatchObject({
        status: "fail",
        details: {
          readinessProbePresent: false,
          productionExceptionAccepted: false
        }
      });
      expect(metricsRequired).toMatchObject({
        status: "fail",
        details: {
          metricsProbePresent: false,
          productionExceptionAccepted: false
        }
      });
      expect(exception).toMatchObject({
        status: "fail",
        details: {
          present: false,
          passed: false
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production when route evidence path does not match the default release evidence path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-default-path-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail(),
        readinessProbe: passingReadinessProbe(),
        metricsProbe: passingMetricsProbe(),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const routeEvidencePath = result.checks.find((check) => check.name === "route_release_evidence_path");

      expect(result.status).toBe("blocked");
      expect(routeEvidencePath).toMatchObject({
        status: "fail",
        details: {
          expectedEvidencePath: evidencePath,
          actualEvidencePath: releaseEvidencePathLabel
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes production without probes when accepted production exception evidence is provided", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-exception-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail(),
        expectedEvidencePath: releaseEvidencePathLabel,
        productionExceptionEvidence: acceptedProductionProbeException(),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const readinessRequired = result.checks.find((check) => check.name === "production_readiness_probe_required");
      const metricsRequired = result.checks.find((check) => check.name === "production_metrics_probe_required");
      const exception = result.checks.find((check) => check.name === "production_probe_exception");

      expect(result.status).toBe("passed");
      expect(readinessRequired).toMatchObject({
        status: "pass",
        details: {
          readinessProbePresent: false,
          productionExceptionAccepted: true
        }
      });
      expect(metricsRequired).toMatchObject({
        status: "pass",
        details: {
          metricsProbePresent: false,
          productionExceptionAccepted: true
        }
      });
      expect(exception).toMatchObject({
        status: "pass",
        details: {
          passed: true,
          targetEnvironment: "production",
          ticket: "INC-2026-0608",
          approved: true,
          unexpired: true,
          identityBound: true,
          releaseMatches: true,
          deploymentMatches: true,
          projectMatches: true,
          channelMatches: true
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production probe exceptions that are not bound to the release and deployment identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-exception-missing-binding-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail(),
        expectedEvidencePath: releaseEvidencePathLabel,
        productionExceptionEvidence: {
          status: "accepted",
          targetEnvironment: "production",
          ticket: "INC-2026-0608",
          reason: "Target probe collector outage; production traffic remains held under incident control.",
          approvedBy: "release-manager",
          expiresAt: "2026-06-08T13:00:00.000Z"
        },
        evaluateBundle: () => bundleCheck(),
        now
      });
      const exception = result.checks.find((check) => check.name === "production_probe_exception");

      expect(result.status).toBe("blocked");
      expect(exception).toMatchObject({
        status: "fail",
        details: {
          passed: false,
          identityBound: false,
          releaseMatches: false,
          deploymentMatches: false,
          projectMatches: false,
          channelMatches: false,
          expectedRelease: {
            commitRef,
            repository,
            branch
          },
          actualRelease: {
            commitRef: null,
            repository: null,
            branch: null
          },
          expectedDeployment: {
            deploymentId: "dep-production",
            projectId: "project-acme-dashboard",
            channel: "production"
          },
          actualDeployment: {
            deploymentId: null,
            projectId: null,
            channel: null
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production probe exceptions whose release or deployment binding does not match", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-exception-binding-mismatch-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail(),
        expectedEvidencePath: releaseEvidencePathLabel,
        productionExceptionEvidence: acceptedProductionProbeException({
          channel: "staging",
          release: {
            commitRef: "different-commit",
            repository,
            branch,
            targetEnvironment: "production"
          },
          deployment: {
            id: "dep-staging",
            projectId: "project-staging",
            environment: "staging"
          },
          project: {
            id: "project-staging"
          }
        }),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const exception = result.checks.find((check) => check.name === "production_probe_exception");

      expect(result.status).toBe("blocked");
      expect(exception).toMatchObject({
        status: "fail",
        details: {
          passed: false,
          identityBound: false,
          releaseMatches: false,
          deploymentMatches: false,
          projectMatches: false,
          channelMatches: false,
          actualRelease: {
            commitRef: "different-commit",
            repository,
            branch
          },
          actualDeployment: {
            deploymentId: "dep-staging",
            projectId: "project-staging",
            channel: "staging"
          }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks raw secret-like values in post-promotion attached evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-secret-attachments-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail({
          diagnostics: {
            authorization: "Bearer abcdefghijklmnop"
          }
        }),
        expectedEvidencePath: releaseEvidencePathLabel,
        readinessProbe: {
          ...passingReadinessProbe(),
          rawSecret: "super-secret-value"
        },
        metricsProbe: {
          ...passingMetricsProbe(),
          token: "ABCDEF1234567890"
        },
        productionExceptionEvidence: acceptedProductionProbeException({
          audit: {
            rawToken: "raw-token-value"
          }
        }),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const secretScan = result.checks.find((check) => check.name === "post_promotion_attached_evidence_no_raw_secrets");

      expect(result.status).toBe("blocked");
      expect(secretScan).toMatchObject({
        status: "fail",
        details: {
          findingCount: expect.any(Number)
        }
      });
      expect(secretScan?.message).toContain("raw secret-like values");
      expect(secretScan?.message).toContain("$.deploymentDetail.diagnostics.authorization");
      expect(secretScan?.message).toContain("$.readinessProbe.rawSecret");
      expect(secretScan?.message).toContain("$.metricsProbe.token");
      expect(secretScan?.message).toContain("$.productionExceptionEvidence.audit.rawToken");
      expect(secretScan?.message).not.toContain("abcdefghijklmnop");
      expect(secretScan?.message).not.toContain("super-secret-value");
      expect(secretScan?.message).not.toContain("ABCDEF1234567890");
      expect(secretScan?.message).not.toContain("raw-token-value");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production readiness probes that redirect instead of returning 200", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-readiness-redirect-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail(),
        expectedEvidencePath: releaseEvidencePathLabel,
        readinessProbe: {
          endpoint: "/readyz",
          statusCode: 302,
          checkedAt: "2026-06-08T11:59:00.000Z"
        },
        metricsProbe: passingMetricsProbe(),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const readinessProbe = result.checks.find((check) => check.name === "readiness_probe_passed");

      expect(result.status).toBe("blocked");
      expect(readinessProbe).toMatchObject({
        status: "fail",
        details: {
          httpStatus: 302,
          endpoint: "/readyz",
          endpointMatches: true,
          timestampFresh: true
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production metrics probes that omit a fresh timestamp", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-metrics-timestamp-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail(),
        expectedEvidencePath: releaseEvidencePathLabel,
        readinessProbe: passingReadinessProbe(),
        metricsProbe: {
          endpoint: "/metrics",
          statusCode: 200
        },
        evaluateBundle: () => bundleCheck(),
        now
      });
      const metricsProbe = result.checks.find((check) => check.name === "metrics_probe_passed");

      expect(result.status).toBe("blocked");
      expect(metricsProbe).toMatchObject({
        status: "fail",
        details: {
          httpStatus: 200,
          endpoint: "/metrics",
          endpointMatches: true,
          checkedAt: null,
          timestampFresh: false
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks production probes that target the wrong endpoint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-wrong-endpoint-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail(),
        expectedEvidencePath: releaseEvidencePathLabel,
        readinessProbe: {
          endpoint: "/healthz",
          statusCode: 200,
          checkedAt: "2026-06-08T11:59:00.000Z"
        },
        metricsProbe: passingMetricsProbe(),
        evaluateBundle: () => bundleCheck(),
        now
      });
      const readinessProbe = result.checks.find((check) => check.name === "readiness_probe_passed");

      expect(result.status).toBe("blocked");
      expect(readinessProbe).toMatchObject({
        status: "fail",
        details: {
          endpoint: "/healthz",
          expectedEndpoint: "/readyz",
          endpointMatches: false,
          timestampFresh: true
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not require probes for non-production channels", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-non-production-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle("staging"));
      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: deploymentDetail({}, "staging"),
        channel: "staging",
        evaluateBundle: () => bundleCheck(),
        now
      });

      expect(result.status).toBe("passed");
      expect(result.checks.find((check) => check.name === "production_readiness_probe_required")).toBeUndefined();
      expect(result.checks.find((check) => check.name === "production_metrics_probe_required")).toBeUndefined();
      expect(result.checks.find((check) => check.name === "production_probe_exception")).toBeUndefined();
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
              totalBytes: 4096,
              checksum: artifactChecksum
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

  it("blocks when route release evidence metadata uses a non-ISO checkedAt timestamp", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-timestamp-non-iso-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const detail = deploymentDetail();
      detail.lineage.routeRevision.releaseEvidence.checkedAt = "June 8, 2026 10:05 UTC";

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
        status: "fail",
        details: {
          releaseEvidenceCheckedAt: "2026-06-08T10:00:00.000Z",
          routeReleaseEvidenceCheckedAt: null,
          checkedAt: "2026-06-08T12:00:00.000Z"
        }
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

  it("blocks when the promoted deployment artifact checksum differs from release artifact evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-post-promote-artifact-checksum-"));

    try {
      const evidencePath = await writeJson(root, "release-evidence.json", releaseEvidenceBundle());
      const detail = deploymentDetail();
      detail.lineage.artifact.manifest.checksum = `sha256:${"b".repeat(64)}`;

      const result = await runReleasePostPromotionEvidenceCheck({
        releaseEvidencePath: evidencePath,
        deploymentDetail: detail,
        evaluateBundle: () => bundleCheck(),
        now
      });
      const artifact = result.checks.find((check) => check.name === "artifact_manifest_matches_release_evidence");

      expect(result.status).toBe("blocked");
      expect(artifact).toMatchObject({
        status: "fail",
        details: {
          expectedChecksum: artifactChecksum,
          actualChecksum: `sha256:${"b".repeat(64)}`
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
        expectedEvidencePath: releaseEvidencePathLabel,
        deploymentDetail: deploymentDetailWithFunctions([
          {
            path: "/api/revalidate",
            sourcePath: ".siteflow/functions/api/revalidate.js",
            runtime: "nodejs20.x",
            handler: "default"
          }
        ]),
        readinessProbe: passingReadinessProbe(),
        metricsProbe: passingMetricsProbe(),
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
        expectedEvidencePath: releaseEvidencePathLabel,
        deploymentDetail: deploymentDetailWithFunctions([
          {
            path: "/api/revalidate",
            sourcePath: ".siteflow/functions/api/revalidate.js",
            runtime: "nodejs20.x",
            runtimeIsolation: "same_process",
            handler: "default"
          }
        ]),
        readinessProbe: passingReadinessProbe(),
        metricsProbe: passingMetricsProbe(),
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
        expectedEvidencePath: releaseEvidencePathLabel,
        deploymentDetail: deploymentDetailWithFunctions([
          {
            path: "/api/revalidate",
            sourcePath: ".siteflow/functions/api/revalidate.js",
            runtime: "nodejs20.x",
            runtimeIsolation: "isolated_process",
            handler: "default"
          }
        ]),
        readinessProbe: passingReadinessProbe(),
        metricsProbe: passingMetricsProbe(),
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
              totalBytes: 4096,
              checksum: artifactChecksum
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
        readinessProbe: passingReadinessProbe(),
        metricsProbe: passingMetricsProbe(),
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
      "--production-exception", "exception.json",
      "--json"
    ])).toEqual({
      releaseEvidencePath: "release.json",
      deploymentDetailPath: "deployment.json",
      deploymentId: "dep-production",
      projectId: "project-acme-dashboard",
      expectedEvidencePath: releaseEvidencePathLabel,
      productionExceptionPath: "exception.json",
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
