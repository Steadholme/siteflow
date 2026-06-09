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
    targetIdentity: passedSection({
      command: "hostname && docker context show && docker context inspect siteflow-prod",
      source: "target_host_identity_probe",
      hostname: "siteflow-prod-01",
      dockerContext: "siteflow-prod",
      dockerContextInspectSha256: "d".repeat(64),
      rawContextArchived: false,
      hostFingerprintSha256: "e".repeat(64),
      composeProject: "siteflow-prod",
      composeFile: "docker-compose.production.yml",
      envFileConfigured: true,
      publicBaseUrl: "https://siteflow.example.com"
    }),
    composeConfig: passedSection({
      command: "docker compose --env-file /etc/siteflow/target.env -f docker-compose.production.yml config",
      source: "target_host_docker_compose_config",
      composeProject: "siteflow-prod",
      services: ["postgres", "api", "worker"],
      secrets: [
        "siteflow_app_secret",
        "siteflow_api_token",
        "siteflow_metrics_token",
        "siteflow_release_evidence_signing_key",
        "siteflow_postgres_password"
      ],
      healthchecks: ["postgres", "api", "worker"],
      images: {
        postgres: postgresImage,
        api: releaseImage,
        worker: releaseImage
      },
      serviceProfiles: {
        api: {
          user: "1000:1000",
          privileged: false,
          readOnly: true,
          capDropAll: true,
          capAdd: [],
          capAddEmpty: true,
          noNewPrivileges: true,
          dangerousSecurityOpt: [],
          dangerousSecurityOptConfigured: false,
          networkMode: null,
          hostNetworkMode: false,
          dockerSocketMounted: false
        },
        worker: {
          user: "1000:1000",
          groupAdd: ["998"],
          groupAddConfigured: true,
          hostDockerSocketGid: 998,
          groupAddMatchesHostDockerSocketGid: true,
          privileged: false,
          readOnly: true,
          capDropAll: true,
          capAdd: [],
          capAddEmpty: true,
          noNewPrivileges: true,
          dangerousSecurityOpt: [],
          dangerousSecurityOptConfigured: false,
          networkMode: null,
          hostNetworkMode: false,
          dockerSocketMounted: true,
          buildRunnerDocker: true,
          buildNetworkNone: true,
          buildMemoryConfigured: true,
          buildCpusConfigured: true,
          buildPidsLimitConfigured: true,
          dockerCliPreflightPresent: true,
          dockerInfoPreflightPresent: true,
          gitSshKeyPathEnvPresent: true,
          gitKnownHostsPathEnvPresent: true
        }
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
      targetIdentity: {
        status: "passed",
        hostname: "siteflow-prod-01",
        dockerContext: "siteflow-prod",
        composeProject: "siteflow-prod"
      },
      workerRuntimePosture: {
        status: "passed",
        dockerSocketMounted: true,
        groupAddConfigured: true,
        hostDockerSocketGid: 998,
        groupAddMatchesHostDockerSocketGid: true,
        privileged: false,
        capAddEmpty: true,
        dangerousSecurityOptConfigured: false,
        hostNetworkMode: false,
        buildRunnerDocker: true,
        buildNetworkNone: true,
        buildMemoryConfigured: true,
        buildCpusConfigured: true,
        buildPidsLimitConfigured: true,
        dockerCliPreflightPresent: true,
        dockerInfoPreflightPresent: true,
        gitSshKeyPathEnvPresent: true,
        gitKnownHostsPathEnvPresent: true
      },
      imageBinding: {
        status: "passed",
        expectedDigest: digest,
        apiImageDigest: digest,
        workerImageDigest: digest
      }
    });
  });

  it("passes real /readyz body status ready", () => {
    const result = evaluateReleaseTargetRuntimeEvidence(passedEvidence({
      readiness: passedSection({
        loopbackStatusCode: 200,
        publicStatusCode: 200,
        loopbackBodyStatus: "ready",
        publicBodyStatus: "ready"
      })
    }), {
      evidencePath: "target-runtime-evidence.json",
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(result.status).toBe("passed");
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "readiness_loopback",
      status: "pass"
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: "readiness_public",
      status: "pass"
    }));
  });

  it("fails when Compose config evidence omits the release evidence signing key secret", () => {
    const evidence = passedEvidence({
      composeConfig: passedSection({
        ...passedEvidence().composeConfig,
        secrets: ["siteflow_app_secret", "siteflow_api_token", "siteflow_metrics_token", "siteflow_postgres_password"]
      })
    });
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
      name: "compose_config_secrets",
      status: "fail"
    }));
  });

  it.each([
    {
      label: "loopback not_ready body",
      bodyStatusField: "loopbackBodyStatus",
      bodyStatus: "not_ready",
      expectedCheck: "readiness_loopback"
    },
    {
      label: "public not_ready body",
      bodyStatusField: "publicBodyStatus",
      bodyStatus: "not_ready",
      expectedCheck: "readiness_public"
    },
    {
      label: "loopback unrelated body",
      bodyStatusField: "loopbackBodyStatus",
      bodyStatus: "healthy",
      expectedCheck: "readiness_loopback"
    },
    {
      label: "public unrelated body",
      bodyStatusField: "publicBodyStatus",
      bodyStatus: "healthy",
      expectedCheck: "readiness_public"
    }
  ])("blocks $label", ({ bodyStatusField, bodyStatus, expectedCheck }) => {
    const readiness = {
      ...(passedEvidence().readiness as Record<string, unknown>),
      [bodyStatusField]: bodyStatus
    };
    const result = evaluateReleaseTargetRuntimeEvidence(passedEvidence({ readiness }), {
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

  it("blocks missing target host identity evidence", () => {
    const result = evaluateReleaseTargetRuntimeEvidence(passedEvidence({ targetIdentity: undefined }), {
      evidencePath: "target-runtime-evidence.json",
      commitRef: "abc123def456",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "target_identity_present",
          status: "fail"
        }),
        expect.objectContaining({
          name: "target_identity_status",
          status: "fail"
        })
      ])
    );
  });

  it.each([
    {
      label: "compose project mismatch",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.targetIdentity as Record<string, unknown>).composeProject = "other-project";
      },
      expectedCheck: "target_identity_compose_project"
    },
    {
      label: "public URL mismatch",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.targetIdentity as Record<string, unknown>).publicBaseUrl = "https://other.example.com";
      },
      expectedCheck: "target_identity_compose_project"
    },
    {
      label: "bad Docker context hash",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.targetIdentity as Record<string, unknown>).dockerContextInspectSha256 = "not-a-sha";
      },
      expectedCheck: "target_identity_docker_context"
    },
    {
      label: "raw Docker context archived",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.targetIdentity as Record<string, unknown>).rawContextArchived = true;
      },
      expectedCheck: "target_identity_docker_context"
    }
  ])("blocks target identity with $label", ({ mutate, expectedCheck }) => {
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
      label: "non-ISO checkedAt",
      mutate: (evidence: Record<string, unknown>) => {
        evidence.checkedAt = "June 8, 2026 11:45 UTC";
      },
      expectedCheck: "evidence_age"
    },
    {
      label: "unsanitized compose config",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.composeConfig as Record<string, unknown>).sanitized = false;
      },
      expectedCheck: "compose_config_sanitized"
    },
    {
      label: "missing compose worker healthcheck",
      mutate: (evidence: Record<string, unknown>) => {
        (evidence.composeConfig as Record<string, unknown>).healthchecks = ["postgres", "api"];
      },
      expectedCheck: "compose_config_healthchecks"
    },
    {
      label: "mutable compose image",
      mutate: (evidence: Record<string, unknown>) => {
        ((evidence.composeConfig as Record<string, unknown>).images as Record<string, unknown>).api = "ghcr.io/siteflow/siteflow:latest";
      },
      expectedCheck: "compose_config_images"
    },
    {
      label: "compose release image digest mismatch",
      mutate: (evidence: Record<string, unknown>) => {
        const images = (evidence.composeConfig as Record<string, unknown>).images as Record<string, unknown>;
        const otherReleaseImage = `ghcr.io/siteflow/siteflow@sha256:${"d".repeat(64)}`;

        images.api = otherReleaseImage;
        images.worker = otherReleaseImage;
      },
      expectedCheck: "compose_config_release_image_digest"
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
      label: "API mounts Docker socket",
      mutate: (evidence: Record<string, unknown>) => {
        const profiles = (evidence.composeConfig as Record<string, unknown>).serviceProfiles as Record<string, unknown>;

        (profiles.api as Record<string, unknown>).dockerSocketMounted = true;
      },
      expectedCheck: "compose_config_api_profile"
    },
    {
      label: "worker runs as root",
      mutate: (evidence: Record<string, unknown>) => {
        const profiles = (evidence.composeConfig as Record<string, unknown>).serviceProfiles as Record<string, unknown>;

        (profiles.worker as Record<string, unknown>).user = "0:0";
      },
      expectedCheck: "compose_config_worker_socket_profile"
    },
    {
      label: "worker missing Docker socket group posture",
      mutate: (evidence: Record<string, unknown>) => {
        const profiles = (evidence.composeConfig as Record<string, unknown>).serviceProfiles as Record<string, unknown>;

        (profiles.worker as Record<string, unknown>).groupAddConfigured = false;
      },
      expectedCheck: "compose_config_worker_socket_profile"
    },
    {
      label: "worker Docker socket gid mismatch",
      mutate: (evidence: Record<string, unknown>) => {
        const profiles = (evidence.composeConfig as Record<string, unknown>).serviceProfiles as Record<string, unknown>;

        (profiles.worker as Record<string, unknown>).hostDockerSocketGid = 999;
        (profiles.worker as Record<string, unknown>).groupAddMatchesHostDockerSocketGid = false;
      },
      expectedCheck: "compose_config_worker_socket_gid"
    },
    {
      label: "worker adds a capability",
      mutate: (evidence: Record<string, unknown>) => {
        const profiles = (evidence.composeConfig as Record<string, unknown>).serviceProfiles as Record<string, unknown>;

        (profiles.worker as Record<string, unknown>).capAdd = ["SYS_ADMIN"];
        (profiles.worker as Record<string, unknown>).capAddEmpty = false;
      },
      expectedCheck: "compose_config_privilege_posture"
    },
    {
      label: "API is privileged",
      mutate: (evidence: Record<string, unknown>) => {
        const profiles = (evidence.composeConfig as Record<string, unknown>).serviceProfiles as Record<string, unknown>;

        (profiles.api as Record<string, unknown>).privileged = true;
      },
      expectedCheck: "compose_config_privilege_posture"
    },
    {
      label: "worker disables seccomp",
      mutate: (evidence: Record<string, unknown>) => {
        const profiles = (evidence.composeConfig as Record<string, unknown>).serviceProfiles as Record<string, unknown>;

        (profiles.worker as Record<string, unknown>).dangerousSecurityOpt = ["seccomp=unconfined"];
        (profiles.worker as Record<string, unknown>).dangerousSecurityOptConfigured = true;
      },
      expectedCheck: "compose_config_privilege_posture"
    },
    {
      label: "worker missing Docker build resource limits",
      mutate: (evidence: Record<string, unknown>) => {
        const profiles = (evidence.composeConfig as Record<string, unknown>).serviceProfiles as Record<string, unknown>;

        (profiles.worker as Record<string, unknown>).buildMemoryConfigured = false;
      },
      expectedCheck: "compose_config_worker_build_resources"
    },
    {
      label: "worker missing Docker socket preflight",
      mutate: (evidence: Record<string, unknown>) => {
        const profiles = (evidence.composeConfig as Record<string, unknown>).serviceProfiles as Record<string, unknown>;

        (profiles.worker as Record<string, unknown>).dockerInfoPreflightPresent = false;
      },
      expectedCheck: "compose_config_worker_socket_profile"
    },
    {
      label: "worker missing private Git credential env wiring",
      mutate: (evidence: Record<string, unknown>) => {
        const profiles = (evidence.composeConfig as Record<string, unknown>).serviceProfiles as Record<string, unknown>;

        (profiles.worker as Record<string, unknown>).gitKnownHostsPathEnvPresent = false;
      },
      expectedCheck: "compose_config_worker_git_credentials"
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
