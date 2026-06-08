import { describe, expect, it } from "vitest";
import { createReleaseTargetRuntimeEvidenceTemplate } from "./releaseTargetRuntimeEvidenceTemplate";
import {
  evaluateReleaseTargetRuntimeEvidence,
  requiredTargetRuntimeEvidenceCheckNames
} from "./releaseTargetRuntimeEvidenceCheck";

const now = () => new Date("2026-06-08T12:00:00.000Z");
const checkedAt = "2026-06-08T11:45:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const releaseImage = `ghcr.io/siteflow/siteflow@${digest}`;
const postgresImage = `postgres@sha256:${"b".repeat(64)}`;

function passedSection(extra: Record<string, unknown> = {}) {
  return {
    status: "passed",
    checkedAt,
    ...extra
  };
}

function passedEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.targetRuntimeEvidence.v1",
    name: "siteflow-target-runtime-evidence",
    status: "passed",
    dryRun: false,
    template: false,
    checkedAt,
    targetEnvironment: "production",
    publicBaseUrl: "https://siteflow.example.com",
    release: {
      commitRef: "abc123def456",
      repository: "acme/siteflow",
      branch: "main"
    },
    composeConfig: passedSection({
      command: "docker compose --env-file /etc/siteflow/target.env -f docker-compose.production.yml config",
      source: "target_host_docker_compose_config",
      composeProject: "siteflow-prod",
      services: ["postgres", "api", "worker"],
      secrets: ["siteflow_app_secret", "siteflow_api_token", "siteflow_metrics_token", "siteflow_postgres_password"],
      healthchecks: ["postgres", "api"],
      images: {
        postgres: postgresImage,
        api: releaseImage,
        worker: releaseImage
      },
      imagePolicy: {
        postgresDigestPinned: true,
        apiDigestPinned: true,
        workerDigestPinned: true,
        noBuildFallback: true
      },
      buildServices: [],
      buildFallbacks: [],
      noBuildFallback: true,
      configSha256: "b".repeat(64),
      sanitized: true,
      rawConfigArchived: false
    }),
    startup: passedSection({
      command: "systemctl restart siteflow.service",
      systemdActive: true,
      systemdEnabled: true
    }),
    serviceHealth: passedSection({
      command: "docker compose --env-file /etc/siteflow/target.env -f docker-compose.production.yml ps --format json",
      composeProject: "siteflow-prod",
      postgresHealthy: true,
      apiHealthy: true,
      workerRunning: true,
      workerHealthy: true,
      workerQueueProbePassed: true,
      workerHeartbeatFresh: true,
      restartLoopDetected: false,
      services: ["postgres", "api", "worker"]
    }),
    readiness: passedSection({
      loopbackStatusCode: 200,
      publicStatusCode: 200,
      loopbackBodyStatus: "ok",
      publicBodyStatus: "ok"
    }),
    imageBinding: passedSection({
      command: "docker compose --env-file /etc/siteflow/target.env -f docker-compose.production.yml ps --format json && docker image inspect ghcr.io/siteflow/siteflow",
      expectedDigest: digest,
      apiImageDigest: digest,
      workerImageDigest: digest,
      apiContainerId: "siteflow-api-1",
      workerContainerId: "siteflow-worker-1",
      apiImageId: `sha256:${"c".repeat(64)}`,
      workerImageId: `sha256:${"c".repeat(64)}`,
      apiMatchesReleaseImage: true,
      workerMatchesReleaseImage: true
    }),
    restartSmoke: passedSection({
      restarted: true,
      serviceHealthAfterRestart: true,
      workerHealthAfterRestart: true,
      readinessAfterRestart: true
    }),
    logSanity: passedSection({
      fatalErrors: 0,
      workerPreflightFailures: 0,
      secretLeakFindings: 0,
      rawLogsArchived: false
    }),
    negativeEvidence: {
      noRawComposeConfigArchived: true,
      noRawEnvArchived: true,
      noRawSecretsArchived: true,
      noUnredactedLogsArchived: true
    },
    operatorName: "release-operator",
    ticketId: "REL-2026-0608",
    ...overrides
  };
}

describe("releaseTargetRuntimeEvidenceCheck", () => {
  it("passes complete target runtime evidence", () => {
    const result = evaluateReleaseTargetRuntimeEvidence(passedEvidence(), {
      evidencePath: "target-runtime-evidence.json",
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.checks.map((check) => check.name)).toEqual(requiredTargetRuntimeEvidenceCheckNames);
    expect(result.selectedEvidence).toMatchObject({
      targetEnvironment: "production",
      commitRef: "abc123def456",
      repository: "acme/siteflow",
      branch: "main",
      imageBinding: {
        status: "passed",
        expectedDigest: digest,
        apiImageDigest: digest,
        workerImageDigest: digest
      }
    });
  });

  it("blocks template evidence", () => {
    const template = createReleaseTargetRuntimeEvidenceTemplate({
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      operatorName: "release-operator",
      ticketId: "REL-2026-0608",
      now
    });
    const result = evaluateReleaseTargetRuntimeEvidence(template, {
      evidencePath: "target-runtime-evidence.json",
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "not_template",
      status: "fail"
    }));
  });

  it("blocks missing image binding evidence", () => {
    const result = evaluateReleaseTargetRuntimeEvidence(passedEvidence({ imageBinding: undefined }), {
      evidencePath: "target-runtime-evidence.json",
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "image_binding_present",
      status: "fail"
    }));
  });

  it.each([
    {
      label: "missing public URL",
      mutate: (evidence: Record<string, unknown>) => {
        delete evidence.publicBaseUrl;
      },
      expectedCheck: "public_base_url"
    },
    {
      label: "unsafe public URL",
      mutate: (evidence: Record<string, unknown>) => {
        evidence.publicBaseUrl = "http://operator:secret@siteflow.example.com?token=raw";
      },
      expectedCheck: "public_base_url"
    },
    {
      label: "wrong release identity",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.release as Record<string, unknown>).commitRef = "other";
      },
      expectedCheck: "release_identity"
    },
    {
      label: "wrong target environment",
      mutate: (evidence: Record<string, unknown>) => {
        evidence.targetEnvironment = "staging";
      },
      expectedCheck: "environment"
    },
    {
      label: "unsanitized compose config",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.composeConfig as Record<string, unknown>).sanitized = false;
      },
      expectedCheck: "compose_config_sanitized"
    },
    {
      label: "mutable compose image",
      mutate: (evidence: Record<string, unknown>) => {
        ((evidence.composeConfig as Record<string, unknown>).images as Record<string, unknown>).api = "ghcr.io/siteflow/siteflow:latest";
      },
      expectedCheck: "compose_config_images"
    },
    {
      label: "compose build fallback",
      mutate: (evidence: Record<string, unknown>) => {
        const composeConfig = evidence.composeConfig as Record<string, unknown>;

        composeConfig.noBuildFallback = false;
        composeConfig.buildServices = ["api"];
      },
      expectedCheck: "compose_config_no_build_fallback"
    },
    {
      label: "missing compose observation source",
      mutate: (evidence: Record<string, unknown>) => {
        delete (evidence.composeConfig as Record<string, unknown>).source;
      },
      expectedCheck: "compose_config_observation"
    },
    {
      label: "missing startup command",
      mutate: (evidence: Record<string, unknown>) => {
        delete (evidence.startup as Record<string, unknown>).command;
      },
      expectedCheck: "startup_observation"
    },
    {
      label: "missing service health command",
      mutate: (evidence: Record<string, unknown>) => {
        delete (evidence.serviceHealth as Record<string, unknown>).command;
      },
      expectedCheck: "service_health_observation"
    },
    {
      label: "missing worker health probe",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.serviceHealth as Record<string, unknown>).workerQueueProbePassed = false;
      },
      expectedCheck: "service_health_worker"
    },
    {
      label: "failed public readiness",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.readiness as Record<string, unknown>).publicStatusCode = 503;
      },
      expectedCheck: "readiness_public"
    },
    {
      label: "image digest mismatch",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.imageBinding as Record<string, unknown>).apiImageDigest = `sha256:${"b".repeat(64)}`;
      },
      expectedCheck: "image_binding_digests"
    },
    {
      label: "missing image binding observation",
      mutate: (evidence: Record<string, unknown>) => {
        delete (evidence.imageBinding as Record<string, unknown>).apiContainerId;
      },
      expectedCheck: "image_binding_observation"
    },
    {
      label: "restart smoke failure",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.restartSmoke as Record<string, unknown>).readinessAfterRestart = false;
      },
      expectedCheck: "restart_smoke_status"
    },
    {
      label: "missing worker health after restart",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.restartSmoke as Record<string, unknown>).workerHealthAfterRestart = false;
      },
      expectedCheck: "restart_smoke_worker_health"
    },
    {
      label: "log sanity failure",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.logSanity as Record<string, unknown>).fatalErrors = 1;
      },
      expectedCheck: "log_sanity_status"
    },
    {
      label: "missing negative evidence",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.negativeEvidence as Record<string, unknown>).noRawEnvArchived = false;
      },
      expectedCheck: "negative_evidence"
    },
    {
      label: "raw secret-like value",
      mutate: (evidence: Record<string, unknown>) => {
        evidence.authorization = "Bearer abcdefghijklmnop";
      },
      expectedCheck: "no_sensitive_evidence_values"
    },
    {
      label: "missing operator",
      mutate: (evidence: Record<string, unknown>) => {
        delete evidence.operatorName;
      },
      expectedCheck: "operator"
    },
    {
      label: "missing ticket",
      mutate: (evidence: Record<string, unknown>) => {
        delete evidence.ticketId;
      },
      expectedCheck: "ticket"
    }
  ])("blocks $label", ({ mutate, expectedCheck }) => {
    const evidence = passedEvidence();
    mutate(evidence);

    const result = evaluateReleaseTargetRuntimeEvidence(evidence, {
      evidencePath: "target-runtime-evidence.json",
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: expectedCheck,
      status: "fail"
    }));
  });
});
