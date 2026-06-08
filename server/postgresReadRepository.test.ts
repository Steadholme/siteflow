import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sealSecretValue } from "../src/lib/sealedSecrets";
import { PostgresSiteFlowReadRepository } from "./postgresReadRepository";

function prebuiltFile(filePath: string, content: string) {
  const bytes = Buffer.from(content);

  return {
    path: filePath,
    contentBase64: bytes.toString("base64"),
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function releaseEvidence(overrides: Record<string, unknown> = {}) {
  return {
    evidencePath: "evidence/release-evidence.json",
    checkedAt: "2026-06-08T12:00:00.000Z",
    status: "passed" as const,
    commitRef: "abc123def4567890",
    repository: "acme/siteflow",
    branch: "main",
    targetEnvironment: "production",
    releaseTicket: "REL-2026-0608",
    operatorName: "release-operator",
    ...overrides
  };
}

function releaseEvidenceQueryValue(query: { values?: unknown[] }) {
  return query.values?.find((value) => typeof value === "string" && value.includes("\"evidencePath\""));
}

function releaseCommandInsertByState(queries: Array<{ text: string; values?: unknown[] }>, state: "succeeded" | "failed") {
  return queries.find((query) => query.text.includes("INSERT INTO siteflow_release_commands") && query.values?.[9] === state);
}

function releaseRouteRows(overrides: {
  sourceBranch?: string | null;
  sourceCommitSha?: string | null;
  sourceRepository?: string | null;
  sourceType?: string;
  manifestReleaseEvidence?: ReturnType<typeof releaseEvidence> | null;
} = {}) {
  const now = new Date("2026-06-08T12:00:00.000Z");
  const candidateSourceBranch = overrides.sourceBranch ?? "main";
  const candidateSourceCommitSha = overrides.sourceCommitSha ?? "abc123def4567890";
  const candidateSourceRepository = overrides.sourceRepository ?? "acme/siteflow";
  const candidateManifestReleaseEvidence = "manifestReleaseEvidence" in overrides
    ? overrides.manifestReleaseEvidence
    : releaseEvidence({
        repository: candidateSourceRepository ?? "acme/siteflow",
        branch: candidateSourceBranch ?? "main",
        commitRef: candidateSourceCommitSha ?? "abc123def4567890"
      });
  const currentDeployment = {
    id: "dep_current",
    project_id: "project_docs",
    status: "ready",
    source_type: "prebuilt",
    source_branch: "main",
    source_commit_sha: "current1234567890",
    source_repository: "acme/siteflow",
    project_repository: {
      provider: "github",
      owner: "acme",
      name: "siteflow",
      defaultBranch: "main"
    },
    artifact_root: "/tmp/siteflow/dep_current",
    entrypoint: "index.html",
    preview_host: "current.w33d.xyz",
    artifact_manifest: {
      entrypoint: "index.html",
      metadata: {
        source: {
          repository: "acme/siteflow",
          branch: "main",
          commitSha: "current1234567890"
        },
        releaseEvidence: releaseEvidence({ commitRef: "current1234567890" })
      }
    }
  };
  const candidateDeployment = {
    id: "dep_prebuilt",
    project_id: "project_docs",
    status: "ready",
    source_type: overrides.sourceType ?? "prebuilt",
    source_branch: candidateSourceBranch,
    source_commit_sha: candidateSourceCommitSha,
    source_repository: candidateSourceRepository,
    project_repository: {
      provider: "github",
      owner: "acme",
      name: "siteflow",
      defaultBranch: "main"
    },
    artifact_root: "/tmp/siteflow/dep_prebuilt",
    entrypoint: "index.html",
    preview_host: "preview.w33d.xyz",
    artifact_manifest: {
      entrypoint: "index.html",
      metadata: {
        source: {
          repository: candidateSourceRepository,
          branch: candidateSourceBranch,
          commitSha: candidateSourceCommitSha
        },
        ...(candidateManifestReleaseEvidence ? { releaseEvidence: candidateManifestReleaseEvidence } : {})
      }
    }
  };

  return {
    project: { id: "project_docs" },
    deployment: candidateDeployment,
    currentDeployment,
    channel: {
      project_id: "project_docs",
      name: "production",
      current_deployment_id: "dep_current",
      pending_deployment_id: null,
      route_revision_id: null,
      updated_by: { id: "actor-1", name: "Ops", role: "operator" },
      updated_at: now
    },
    rollout: {
      id: "rollout_active",
      project_id: "project_docs",
      channel: "production",
      current_deployment_id: "dep_current",
      candidate_deployment_id: "dep_prebuilt",
      percentage: 10,
      status: "active",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "canary",
      route_revision_id: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
      aborted_at: null
    },
    domain: {
      project_id: "project_docs",
      hostname: "docs.example.com",
      channel: "production",
      verified: true,
      last_checked_at: now
    }
  };
}

function releaseRouteClient(overrides: {
  sourceBranch?: string | null;
  sourceCommitSha?: string | null;
  sourceRepository?: string | null;
  activeRollout?: boolean;
  existingReleaseCommand?: boolean;
  releaseCommandInsertConflict?: boolean;
} = {}) {
  const rows = releaseRouteRows(overrides);
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const evidence = releaseEvidence();
  let releaseCommandReads = 0;
  const routeRevisionRow = {
    id: "route_promote",
    project_id: "project_docs",
    channel: "production",
    deployment_id: "dep_prebuilt",
    previous_deployment_id: "dep_current",
    status: "applied",
    generated_config: "project=project_docs",
    validation_summary: "Promotion route applied.",
    release_evidence: evidence,
    created_at: new Date("2026-06-08T12:00:00.000Z"),
    applied_at: new Date("2026-06-08T12:00:00.000Z"),
    failed_reason: null
  };

  const client = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });

      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }

      if (text.includes("pg_advisory_xact_lock")) {
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_release_commands") && text.includes("WHERE idempotency_key = $1")) {
        releaseCommandReads += 1;
        const returnExisting = overrides.existingReleaseCommand || (overrides.releaseCommandInsertConflict && releaseCommandReads > 1);

        return {
          rows: returnExisting
            ? [
                {
                  idempotency_key: String(values?.[0]),
                  operation_id: "op_existing",
                  action: "promote",
                  project_id: "project_docs",
                  channel: "production",
                  current_deployment_id: "dep_current",
                  target_deployment_id: "dep_prebuilt",
                  state: "succeeded",
                  actor: { id: "actor-1", name: "Ops", role: "operator" },
                  reason: "ship",
                  message: "Promotion route applied.",
                  route_revision_id: routeRevisionRow.id,
                  release_evidence: evidence,
                  created_at: new Date("2026-06-08T12:00:00.000Z"),
                  updated_at: new Date("2026-06-08T12:00:00.000Z")
                }
              ]
            : [],
          rowCount: returnExisting ? 1 : 0
        };
      }

      if (text.includes("SELECT id FROM siteflow_projects")) {
        return { rows: [rows.project], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_deployments deployment") && text.includes("JOIN siteflow_projects project")) {
        return {
          rows: [values?.[0] === "dep_current" ? rows.currentDeployment : rows.deployment],
          rowCount: 1
        };
      }

      if (text.includes("FROM siteflow_release_channels")) {
        return { rows: [rows.channel], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_project_domains")) {
        return { rows: [rows.domain], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_route_revisions") && text.includes("WHERE id = $1")) {
        return { rows: [routeRevisionRow], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_rolling_releases") && text.includes("status = 'active'")) {
        return { rows: overrides.activeRollout ? [rows.rollout] : [], rowCount: overrides.activeRollout ? 1 : 0 };
      }

      if (text.includes("INSERT INTO siteflow_route_revisions")) {
        const evidenceValue = values?.find((value) => typeof value === "string" && value.includes("\"evidencePath\""));

        return {
          rows: [
            {
              ...routeRevisionRow,
              release_evidence: evidenceValue ? JSON.parse(String(evidenceValue)) : null
            }
          ],
          rowCount: 1
        };
      }

      if (text.includes("INSERT INTO siteflow_rolling_releases")) {
        return {
          rows: [
            {
              ...rows.rollout,
              id: String(values?.[0]),
              current_deployment_id: String(values?.[3]),
              candidate_deployment_id: String(values?.[4]),
              percentage: Number(values?.[5] ?? 0),
              reason: String(values?.[7]),
              route_revision_id: String(values?.[9]),
              created_at: new Date("2026-06-08T12:00:00.000Z"),
              updated_at: new Date("2026-06-08T12:00:00.000Z")
            }
          ],
          rowCount: 1
        };
      }

      if (text.includes("INSERT INTO siteflow_release_channels")) {
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("INSERT INTO siteflow_audit_events")) {
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("INSERT INTO siteflow_artifact_routes")) {
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("INSERT INTO siteflow_release_commands")) {
        if (overrides.releaseCommandInsertConflict) {
          return { rows: [], rowCount: 0 };
        }

        return {
          rows: [
            {
              idempotency_key: String(values?.[0]),
              operation_id: String(values?.[1]),
              action: values?.[2] as string,
              project_id: String(values?.[3]),
              channel: values?.[4] as string,
              current_deployment_id: values?.[5] as string | null,
              target_deployment_id: String(values?.[6]),
              actor: JSON.parse(String(values?.[7])),
              reason: String(values?.[8]),
              state: values?.[9] as string,
              message: String(values?.[10]),
              route_revision_id: values?.[11] as string | null,
              release_evidence: values?.[12] ? JSON.parse(String(values?.[12])) : null,
              created_at: new Date("2026-06-08T12:00:00.000Z"),
              updated_at: new Date("2026-06-08T12:00:00.000Z")
            }
          ],
          rowCount: 1
        };
      }

      if (text.includes("UPDATE siteflow_rolling_releases")) {
        return {
          rows: [
            {
              ...rows.rollout,
              percentage: Number(values?.[1] ?? rows.rollout.percentage),
              status: values?.[2] as string,
              reason: String(values?.[4]),
              route_revision_id: String(values?.[5]),
              updated_at: new Date("2026-06-08T12:01:00.000Z"),
              completed_at: values?.[2] === "completed" ? new Date("2026-06-08T12:01:00.000Z") : null,
              aborted_at: values?.[2] === "aborted" ? new Date("2026-06-08T12:01:00.000Z") : null
            }
          ],
          rowCount: 1
        };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
    release: () => undefined
  };

  return { client, queries };
}

function consoleFallbackPool() {
  const rows = releaseRouteRows();
  const now = new Date("2026-06-08T12:00:00.000Z");
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const project = {
    id: "project_docs",
    slug: "docs",
    name: "Docs",
    status: "active",
    framework: "vite",
    default_branch: "main",
    production_branch: "main",
    repository: {
      provider: "github",
      owner: "acme",
      name: "siteflow",
      defaultBranch: "main"
    },
    build_settings: {},
    created_at: now,
    updated_at: now
  };
  const summaryRows = [
    {
      id: "dep_prebuilt",
      project_id: "project_docs",
      project_name: "Docs",
      source_branch: "main",
      source_commit_sha: "abc123def4567890",
      status: "ready",
      checksum: "sha256:candidate",
      file_count: 3,
      total_bytes: "128",
      artifact_manifest: { entrypoint: "index.html" },
      created_at: new Date("2026-06-08T12:00:00.000Z"),
      route_revision_id: null,
      route_revision_status: null
    },
    {
      id: "dep_current",
      project_id: "project_docs",
      project_name: "Docs",
      source_branch: "main",
      source_commit_sha: "current1234567890",
      status: "ready",
      checksum: "sha256:current",
      file_count: 2,
      total_bytes: "96",
      artifact_manifest: { entrypoint: "index.html" },
      created_at: new Date("2026-06-08T11:00:00.000Z"),
      route_revision_id: "route_promote",
      route_revision_status: "applied"
    }
  ];
  const productionChannel = {
    ...rows.channel,
    route_revision_id: "route_promote"
  };
  const routeRevisionRow = {
    id: "route_promote",
    project_id: "project_docs",
    channel: "production",
    deployment_id: "dep_current",
    previous_deployment_id: "dep_previous",
    status: "applied",
    generated_config: "project=project_docs",
    validation_summary: "Production route applied.",
    release_evidence: releaseEvidence(),
    created_at: now,
    applied_at: now,
    failed_reason: null
  };
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      queries.push({ text, values });

      if (text.includes("siteflow_read_models")) {
        return { rows: [], rowCount: 0 };
      }

      if (text.includes("FROM siteflow_projects") && text.includes("ORDER BY updated_at DESC")) {
        return { rows: [project], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_projects") && text.includes("WHERE id = $1")) {
        return { rows: [project], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_project_domains")) {
        return { rows: [rows.domain], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_release_channels")) {
        return { rows: [productionChannel], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_deployments deployment") && text.includes("deployment.artifact_root")) {
        return {
          rows: [values?.[0] === "dep_current" ? rows.currentDeployment : rows.deployment],
          rowCount: 1
        };
      }

      if (text.includes("FROM siteflow_deployments deployment") && text.includes("deployment.checksum")) {
        return { rows: summaryRows, rowCount: summaryRows.length };
      }

      if (text.includes("count(*) AS count") && text.includes("FROM siteflow_release_commands")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_release_commands")) {
        return {
          rows: [
            {
              idempotency_key: "promote-production",
              operation_id: "op_existing",
              action: "promote",
              project_id: "project_docs",
              channel: "production",
              current_deployment_id: "dep_previous",
              target_deployment_id: "dep_current",
              state: "succeeded",
              actor: { id: "actor-1", name: "Ops", role: "operator" },
              reason: "ship",
              message: "Promotion route applied.",
              route_revision_id: "route_promote",
              release_evidence: releaseEvidence(),
              created_at: now,
              updated_at: now
            }
          ],
          rowCount: 1
        };
      }

      if (text.includes("FROM siteflow_source_events")) {
        return {
          rows: [
            {
              id: "src_push",
              project_id: "project_docs",
              kind: "push",
              status: "accepted",
              disposition: "build_requested",
              provider_delivery_id: "delivery-1",
              branch: "main",
              commit_sha: "abc123def4567890",
              commit_message: "Ship docs",
              commit_author: "Ada",
              pull_request_number: null,
              received_at: now,
              actor: { id: "github:ada", name: "ada", role: "developer" }
            }
          ],
          rowCount: 1
        };
      }

      if (text.includes("FROM siteflow_route_revisions") && text.includes("WHERE id = $1")) {
        return { rows: [routeRevisionRow], rowCount: 1 };
      }

      if (text.includes("FROM siteflow_audit_events")) {
        return {
          rows: [
            {
              id: "audit_release",
              project_id: "project_docs",
              action: "deployment.promoted",
              actor: { id: "actor-1", name: "Ops", role: "operator" },
              target_type: "deployment",
              target_id: "dep_current",
              summary: "Promotion route applied.",
              reason: "ship",
              metadata: {},
              created_at: now
            }
          ],
          rowCount: 1
        };
      }

      throw new Error(`Unexpected query: ${text}`);
    }
  };

  return { pool, queries };
}

describe("PostgresSiteFlowReadRepository", () => {
  it("updates existing project repository metadata from signed git webhook events before queueing builds", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    let sourceEventReads = 0;
    const projectRow = {
      id: "project_docs",
      slug: "docs-portal",
      name: "Docs Portal",
      status: "active",
      framework: "static",
      default_branch: "main",
      production_branch: "main",
      repository: {
        provider: "github",
        owner: "acme",
        name: "docs-portal",
        defaultBranch: "main"
      },
      build_settings: {},
      created_at: new Date("2026-06-08T00:00:00.000Z"),
      updated_at: new Date("2026-06-08T00:00:00.000Z")
    };
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("FROM siteflow_projects") && text.includes("repository->>'provider'")) {
          return { rows: [projectRow], rowCount: 1 };
        }

        if (text.includes("UPDATE siteflow_projects") && text.includes("SET repository = $2::jsonb")) {
          return {
            rows: [
              {
                ...projectRow,
                repository: JSON.parse(String(values?.[1])),
                updated_at: new Date("2026-06-08T00:01:00.000Z")
              }
            ],
            rowCount: 1
          };
        }

        if (text.includes("FROM siteflow_source_events") && text.includes("provider_delivery_id = $2")) {
          sourceEventReads += 1;
          return {
            rows: sourceEventReads === 1
              ? []
              : [
                  {
                    id: "src_delivery_1",
                    project_id: "project_docs",
                    kind: "push",
                    status: "accepted",
                    disposition: "build_requested",
                    provider_delivery_id: "delivery-1",
                    branch: "main",
                    commit_sha: "abc123def456",
                    commit_message: "Ship docs",
                    commit_author: "Ada",
                    pull_request_number: null,
                    received_at: new Date("2026-06-08T00:01:00.000Z"),
                    actor: { id: "github:ada", name: "ada", role: "developer" }
                  }
                ],
            rowCount: sourceEventReads === 1 ? 0 : 1
          };
        }

        if (text.includes("INSERT INTO siteflow_source_events") || text.includes("INSERT INTO siteflow_build_jobs")) {
          return { rows: [], rowCount: 1 };
        }

        throw new Error(`Unexpected query: ${text}`);
      }
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.ingestGitWebhook({
      provider: "github",
      deliveryId: "delivery-1",
      event: {
        provider: "github",
        deliveryId: "delivery-1",
        kind: "push",
        repository: {
          provider: "github",
          owner: "acme",
          name: "docs-portal",
          defaultBranch: "main",
          providerPayload: {
            remoteUrl: "git@github.com:acme/docs-portal.git",
            htmlUrl: "https://github.com/acme/docs-portal"
          }
        },
        branch: "main",
        commitSha: "abc123def456",
        commitMessage: "Ship docs",
        commitAuthor: "Ada",
        receivedAt: "2026-06-08T00:01:00.000Z",
        actor: { id: "github:ada", name: "ada", role: "developer" }
      }
    });
    const update = queries.find((query) => query.text.includes("UPDATE siteflow_projects") && query.text.includes("SET repository = $2::jsonb"));
    const updatedRepository = JSON.parse(String(update?.values?.[1]));

    expect(result.status).toBe("accepted");
    expect(updatedRepository).toMatchObject({
      provider: "github",
      owner: "acme",
      name: "docs-portal",
      providerPayload: {
        remoteUrl: "git@github.com:acme/docs-portal.git",
        htmlUrl: "https://github.com/acme/docs-portal"
      }
    });
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_projects"))).toBe(false);
  });

  it("binds production promotion release evidence to the target deployment identity", async () => {
    const { client, queries } = releaseRouteClient();
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const evidence = releaseEvidence();

    const result = await repository.promoteDeployment({
      projectId: "project_docs",
      channel: "production",
      targetDeploymentId: "dep_prebuilt",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "ship",
      idempotencyKey: "promote-production",
      releaseEvidence: evidence
    });
    const routeRevisionInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_route_revisions"));
    const releaseCommandInsert = releaseCommandInsertByState(queries, "succeeded");
    const commandLockIndex = queries.findIndex((query) =>
      query.text.includes("pg_advisory_xact_lock") && query.values?.[0] === "siteflow:release-command"
    );
    const commandReadIndex = queries.findIndex((query) => query.text.includes("FROM siteflow_release_commands") && query.text.includes("FOR UPDATE"));
    const channelLockIndex = queries.findIndex((query) =>
      query.text.includes("pg_advisory_xact_lock") && query.values?.[0] === "siteflow:release-channel"
    );
    const channelReadIndex = queries.findIndex((query) => query.text.includes("FROM siteflow_release_channels") && query.text.includes("FOR UPDATE"));

    expect(result.status).toBe("accepted");
    expect(commandLockIndex).toBeGreaterThan(-1);
    expect(commandReadIndex).toBeGreaterThan(commandLockIndex);
    expect(channelLockIndex).toBeGreaterThan(commandReadIndex);
    expect(channelReadIndex).toBeGreaterThan(channelLockIndex);
    expect(queries[commandLockIndex].values).toEqual(["siteflow:release-command", "promote-production"]);
    expect(queries[channelLockIndex].values).toEqual(["siteflow:release-channel", "project_docs:production"]);
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-target-identity",
        status: "pass"
      })
    ]));
    expect(releaseEvidenceQueryValue(routeRevisionInsert ?? {})).toBe(JSON.stringify(evidence));
    expect(releaseCommandInsert?.values?.[12]).toBe(JSON.stringify(evidence));
  });

  it("rejects production promotion for prebuilt targets without manifest release evidence", async () => {
    const { client, queries } = releaseRouteClient({ manifestReleaseEvidence: null });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.promoteDeployment({
      projectId: "project_docs",
      channel: "production",
      targetDeploymentId: "dep_prebuilt",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "ship",
      idempotencyKey: "promote-production-missing-manifest-evidence",
      releaseEvidence: releaseEvidence()
    });

    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Production prebuilt target must include checked release evidence metadata");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-prebuilt-origin",
        status: "fail"
      })
    ]));
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_route_revisions"))).toBe(false);
  });

  it("rejects production promotion when prebuilt manifest release evidence does not match the target evidence", async () => {
    const { client, queries } = releaseRouteClient({
      manifestReleaseEvidence: releaseEvidence({ commitRef: "different-commit" })
    });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.promoteDeployment({
      projectId: "project_docs",
      channel: "production",
      targetDeploymentId: "dep_prebuilt",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "ship",
      idempotencyKey: "promote-production-manifest-evidence-mismatch",
      releaseEvidence: releaseEvidence()
    });

    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Prebuilt artifact manifest release evidence targets");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-prebuilt-origin",
        status: "fail"
      })
    ]));
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_route_revisions"))).toBe(false);
  });

  it("rejects production promotion when release evidence does not match the target deployment identity", async () => {
    const { client, queries } = releaseRouteClient({ sourceCommitSha: "different-commit" });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const evidence = releaseEvidence();

    const result = await repository.promoteDeployment({
      projectId: "project_docs",
      channel: "production",
      targetDeploymentId: "dep_prebuilt",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "ship",
      idempotencyKey: "promote-production-mismatch",
      releaseEvidence: evidence
    });
    const failedReleaseCommandInsert = releaseCommandInsertByState(queries, "failed");

    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Release evidence targets");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-target-identity",
        status: "fail"
      })
    ]));
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_route_revisions"))).toBe(false);
    expect(failedReleaseCommandInsert?.values?.[12]).toBe(JSON.stringify(evidence));
  });

  it("returns persisted release evidence on idempotent production promotion replay", async () => {
    const { client, queries } = releaseRouteClient({ existingReleaseCommand: true });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const evidence = releaseEvidence();

    const result = await repository.promoteDeployment({
      projectId: "project_docs",
      channel: "production",
      targetDeploymentId: "dep_prebuilt",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "ship",
      idempotencyKey: "promote-production",
      releaseEvidence: evidence
    });

    expect(result.status).toBe("accepted");
    expect(result.routeRevision?.releaseEvidence).toEqual(evidence);
    expect(queries.some((query) => query.text.includes("FROM siteflow_deployments deployment"))).toBe(false);
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_release_commands"))).toBe(false);
  });

  it("replays the existing release command when insert loses an idempotency race", async () => {
    const { client, queries } = releaseRouteClient({ releaseCommandInsertConflict: true });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.promoteDeployment({
      projectId: "project_docs",
      channel: "production",
      targetDeploymentId: "dep_prebuilt",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "ship",
      idempotencyKey: "promote-production",
      releaseEvidence: releaseEvidence()
    });
    const releaseCommandInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_release_commands"));
    const releaseCommandReads = queries.filter((query) =>
      query.text.includes("FROM siteflow_release_commands") && query.text.includes("WHERE idempotency_key = $1")
    );

    expect(result.status).toBe("accepted");
    expect(result.operationId).toBe("op_existing");
    expect(result.routeRevision?.id).toBe("route_promote");
    expect(releaseCommandInsert?.text).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(releaseCommandInsert?.text).toContain("RETURNING idempotency_key");
    expect(releaseCommandReads).toHaveLength(2);
  });

  it("returns release evidence when polling a failed promotion without a route revision", async () => {
    const evidence = releaseEvidence();
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return {
          rows: [
            {
              operation_id: "op_failed",
              action: "promote",
              project_id: "project_docs",
              channel: "production",
              target_deployment_id: "dep_prebuilt",
              state: "failed",
              message: "Promotion rejected.",
              route_revision_id: null,
              release_evidence: evidence,
              updated_at: new Date("2026-06-08T12:00:00.000Z")
            }
          ],
          rowCount: 1
        };
      }
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.pollOperation("op_failed");

    expect(result).toMatchObject({
      operationId: "op_failed",
      state: "failed",
      kind: "promotion",
      targetDeploymentId: "dep_prebuilt",
      releaseEvidence: evidence
    });
    expect(result.routeRevision).toBeUndefined();
    expect(queries.some((query) => query.text.includes("release_evidence"))).toBe(true);
  });

  it("binds production rollback release evidence to the target deployment identity", async () => {
    const { client, queries } = releaseRouteClient();
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const evidence = releaseEvidence();

    const result = await repository.rollbackDeployment({
      projectId: "project_docs",
      channel: "production",
      currentDeploymentId: "dep_current",
      targetDeploymentId: "dep_prebuilt",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "rollback",
      idempotencyKey: "rollback-production",
      releaseEvidence: evidence
    });
    const routeRevisionInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_route_revisions"));
    const releaseCommandInsert = releaseCommandInsertByState(queries, "succeeded");

    expect(result.status).toBe("accepted");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-target-identity",
        status: "pass"
      })
    ]));
    expect(releaseEvidenceQueryValue(routeRevisionInsert ?? {})).toBe(JSON.stringify(evidence));
    expect(releaseCommandInsert?.values?.[12]).toBe(JSON.stringify(evidence));
  });

  it("rejects production rollback without release evidence metadata", async () => {
    const { client, queries } = releaseRouteClient();
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.rollbackDeployment({
      projectId: "project_docs",
      channel: "production",
      currentDeploymentId: "dep_current",
      targetDeploymentId: "dep_prebuilt",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "rollback",
      idempotencyKey: "rollback-production-missing-evidence"
    });
    const failedReleaseCommandInsert = releaseCommandInsertByState(queries, "failed");

    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Production release requires release evidence metadata");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-target-identity",
        status: "fail"
      })
    ]));
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_route_revisions"))).toBe(false);
    expect(failedReleaseCommandInsert?.values?.[12]).toBeNull();
  });

  it("rejects production rollback when release evidence does not match the target deployment identity", async () => {
    const { client, queries } = releaseRouteClient({ sourceCommitSha: "different-commit" });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const evidence = releaseEvidence();

    const result = await repository.rollbackDeployment({
      projectId: "project_docs",
      channel: "production",
      currentDeploymentId: "dep_current",
      targetDeploymentId: "dep_prebuilt",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "rollback",
      idempotencyKey: "rollback-production-mismatch",
      releaseEvidence: evidence
    });
    const failedReleaseCommandInsert = releaseCommandInsertByState(queries, "failed");

    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Release evidence targets");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-target-identity",
        status: "fail"
      })
    ]));
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_route_revisions"))).toBe(false);
    expect(failedReleaseCommandInsert?.values?.[12]).toBe(JSON.stringify(evidence));
  });

  it("returns route release evidence when reading deployment detail", async () => {
    const evidence = releaseEvidence();
    const now = new Date("2026-06-08T12:00:00.000Z");
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("siteflow_read_models")) {
          return { rows: [] };
        }

        if (text.includes("FROM siteflow_deployments deployment")) {
          return {
            rows: [
              {
                id: "dep_prebuilt",
                project_id: "project_docs",
                source_branch: "main",
                source_commit_sha: "abc123def4567890",
                source_event_id: null,
                build_job_id: null,
                deployment_status: "ready",
                artifact_root: "/tmp/siteflow/dep_prebuilt",
                checksum: "sha256:abc",
                file_count: 1,
                total_bytes: "128",
                preview_host: "preview.w33d.xyz",
                artifact_manifest: {
                  entrypoint: "index.html"
                },
                deployment_created_at: now,
                project_slug: "docs",
                project_name: "Docs",
                project_status: "active",
                project_framework: "vite",
                project_default_branch: "main",
                project_production_branch: "main",
                project_repository: {
                  provider: "github",
                  owner: "acme",
                  name: "siteflow",
                  defaultBranch: "main"
                },
                project_build_settings: {},
                project_created_at: now,
                project_updated_at: now,
                source_kind: null,
                source_status: null,
                source_disposition: null,
                provider_delivery_id: null,
                source_branch_name: null,
                source_commit_message: null,
                source_commit_author: null,
                source_received_at: null,
                source_actor: null,
                build_status: null,
                build_framework: null,
                install_command: null,
                build_command: null,
                output_directory: null,
                queued_at: null,
                started_at: null,
                finished_at: null,
                worker_id: null,
                route_revision_id: "route_production",
                route_channel: "production",
                route_previous_deployment_id: "dep_current",
                route_status: "applied",
                route_generated_config: "server { return 200; }",
                route_validation_summary: "Route config validated.",
                route_release_evidence: evidence,
                route_created_at: now,
                route_applied_at: now,
                route_failed_reason: null
              }
            ]
          };
        }

        if (text.includes("FROM siteflow_project_domains")) {
          return { rows: [] };
        }

        throw new Error(`Unexpected query: ${text}`);
      }
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.getDeployment("dep_prebuilt");

    expect(result.lineage.routeRevision?.releaseEvidence).toEqual(evidence);
    expect(result.routeEvidence?.routeRevision.releaseEvidence).toEqual(evidence);
    expect(queries.some((query) => query.text.includes("route.release_evidence AS route_release_evidence"))).toBe(true);
  });

  it("builds the release console from relational tables when the read model cache is empty", async () => {
    const { pool, queries } = consoleFallbackPool();
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.getReleaseConsole("project_docs", "production");

    expect(result.project.id).toBe("project_docs");
    expect(result.channel).toBe("production");
    expect(result.currentDeployment?.id).toBe("dep_current");
    expect(result.candidateDeployment?.id).toBe("dep_prebuilt");
    expect(result.routePreview?.routeRevision).toMatchObject({
      channel: "production",
      deploymentId: "dep_prebuilt",
      previousDeploymentId: "dep_current",
      status: "planned"
    });
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "check-target-deployment-ready", status: "pass" })
    ]));
    expect(result.recentChannelEvents[0]).toMatchObject({
      action: "promote",
      nextDeploymentId: "dep_current"
    });
    expect(queries.some((query) => query.text.includes("siteflow_read_models"))).toBe(true);
    expect(queries.some((query) => query.text.includes("FROM siteflow_release_channels"))).toBe(true);
  });

  it("builds the rollback console from relational tables when the read model cache is empty", async () => {
    const { pool } = consoleFallbackPool();
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.getRollbackConsole("project_docs", "production");

    expect(result.project.id).toBe("project_docs");
    expect(result.currentDeployment?.id).toBe("dep_current");
    expect(result.selectedTargetId).toBe("dep_prebuilt");
    expect(result.targets[0]).toMatchObject({
      eligible: true,
      deployment: {
        id: "dep_prebuilt",
        artifactVerificationStatus: "verified"
      }
    });
    expect(result.targets[0]?.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "check-rollback-target-distinct", status: "pass" })
    ]));
    expect(result.routePreview?.routeRevision).toMatchObject({
      channel: "production",
      deploymentId: "dep_prebuilt",
      previousDeploymentId: "dep_current",
      status: "planned"
    });
    expect(result.routePreview?.previousKnownGoodDeploymentId).toBe("dep_current");
  });

  it("builds the project list from relational tables when the read model cache is empty", async () => {
    const { pool, queries } = consoleFallbackPool();
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.listProjects();

    expect(result.summary).toMatchObject({
      totalProjects: 1,
      activeProjects: 1,
      activeOperations: 0
    });
    expect(result.projects[0]).toMatchObject({
      project: {
        id: "project_docs",
        name: "Docs"
      },
      productionDeployment: {
        id: "dep_current"
      },
      pendingDeploymentCount: 0,
      lastSourceEvent: {
        id: "src_push"
      },
      lastAuditEvent: {
        id: "audit_release"
      }
    });
    expect(result.recentEvents.sourceEvents[0]?.id).toBe("src_push");
    expect(result.recentEvents.auditEvents[0]?.id).toBe("audit_release");
    expect(queries.some((query) => query.text.includes("SELECT payload FROM siteflow_read_models"))).toBe(true);
    expect(queries.some((query) => query.text.includes("FROM siteflow_projects") && query.text.includes("ORDER BY updated_at DESC"))).toBe(true);
  });

  it("builds project detail from relational tables when the read model cache is empty", async () => {
    const { pool } = consoleFallbackPool();
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.getProject("project_docs");

    expect(result.project.id).toBe("project_docs");
    expect(result.deployments.map((deployment) => deployment.id)).toEqual(["dep_prebuilt", "dep_current"]);
    expect(result.channels[0]).toMatchObject({
      channel: {
        projectId: "project_docs",
        name: "production",
        currentDeploymentId: "dep_current"
      },
      currentDeployment: {
        id: "dep_current"
      },
      routeRevision: {
        id: "route_promote"
      }
    });
    expect(result.routeEvidence[0]).toMatchObject({
      routeRevision: {
        id: "route_promote",
        deploymentId: "dep_current"
      },
      previousKnownGoodDeploymentId: "dep_previous"
    });
    expect(result.recentEvents.channelEvents[0]).toMatchObject({
      action: "promote",
      nextDeploymentId: "dep_current"
    });
  });

  it("binds production rolling start release evidence to the candidate deployment identity", async () => {
    const { client, queries } = releaseRouteClient();
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const evidence = releaseEvidence();

    const result = await repository.startRollingRelease({
      projectId: "project_docs",
      channel: "production",
      candidateDeploymentId: "dep_prebuilt",
      percentage: 10,
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "start canary",
      idempotencyKey: "rolling-start",
      releaseEvidence: evidence
    });
    const routeRevisionInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_route_revisions"));

    expect(result.status).toBe("accepted");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-target-identity",
        status: "pass"
      })
    ]));
    expect(releaseEvidenceQueryValue(routeRevisionInsert ?? {})).toBe(JSON.stringify(evidence));
  });

  it("rejects production rolling start for prebuilt candidates without manifest release evidence", async () => {
    const { client, queries } = releaseRouteClient({ manifestReleaseEvidence: null });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.startRollingRelease({
      projectId: "project_docs",
      channel: "production",
      candidateDeploymentId: "dep_prebuilt",
      percentage: 10,
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "start canary",
      idempotencyKey: "rolling-start-missing-manifest-evidence",
      releaseEvidence: releaseEvidence()
    });

    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Production prebuilt target must include checked release evidence metadata");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-prebuilt-origin",
        status: "fail"
      })
    ]));
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_route_revisions"))).toBe(false);
  });

  it("rejects production rolling start when release evidence does not match the candidate deployment identity", async () => {
    const { client, queries } = releaseRouteClient({ sourceBranch: "release/wrong" });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.startRollingRelease({
      projectId: "project_docs",
      channel: "production",
      candidateDeploymentId: "dep_prebuilt",
      percentage: 10,
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "start canary",
      idempotencyKey: "rolling-start-mismatch",
      releaseEvidence: releaseEvidence()
    });

    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Release evidence targets");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-target-identity",
        status: "fail"
      })
    ]));
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_route_revisions"))).toBe(false);
  });

  it.each([
    {
      action: "advance" as const,
      run: (repository: PostgresSiteFlowReadRepository, evidence: ReturnType<typeof releaseEvidence>) =>
        repository.advanceRollingRelease({
          projectId: "project_docs",
          channel: "production",
          percentage: 50,
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "advance canary",
          idempotencyKey: "rolling-advance",
          releaseEvidence: evidence
        })
    },
    {
      action: "complete" as const,
      run: (repository: PostgresSiteFlowReadRepository, evidence: ReturnType<typeof releaseEvidence>) =>
        repository.completeRollingRelease({
          projectId: "project_docs",
          channel: "production",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "complete canary",
          idempotencyKey: "rolling-complete",
          releaseEvidence: evidence
        })
    }
  ])("binds production rolling $action release evidence to the active candidate deployment identity", async ({ run }) => {
    const { client, queries } = releaseRouteClient({ activeRollout: true });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const evidence = releaseEvidence();

    const result = await run(repository, evidence);
    const routeRevisionInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_route_revisions"));

    expect(result.status).toBe("accepted");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-target-identity",
        status: "pass"
      })
    ]));
    expect(releaseEvidenceQueryValue(routeRevisionInsert ?? {})).toBe(JSON.stringify(evidence));
  });

  it("records production rolling abort stop-rollout release evidence exception", async () => {
    const { client, queries } = releaseRouteClient({ activeRollout: true });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const releaseEvidenceException = {
      type: "production_rolling_abort_stop_rollout" as const,
      targetEnvironment: "production" as const,
      acceptedWithoutReleaseEvidence: true as const,
      reason: "stop canary"
    };

    const result = await repository.abortRollingRelease({
      projectId: "project_docs",
      channel: "production",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "stop canary",
      idempotencyKey: "rolling-abort",
      releaseEvidenceException
    });
    const routeRevisionInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_route_revisions"));
    const auditInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_audit_events"));
    const generatedConfig = String(routeRevisionInsert?.values?.[5] ?? "");
    const auditMetadata = JSON.parse(String(auditInsert?.values?.[8] ?? "{}"));

    expect(result.status).toBe("accepted");
    expect(routeRevisionInsert?.values?.[9]).toBeNull();
    expect(generatedConfig).toContain("release_evidence_exception=production_rolling_abort_stop_rollout");
    expect(generatedConfig).toContain("release_evidence_exception_target_environment=production");
    expect(generatedConfig).toContain("release_evidence_exception_reason=stop canary");
    expect(auditInsert?.values?.[2]).toBe("rolling_release.aborted");
    expect(auditInsert?.values?.[7]).toBe("stop canary");
    expect(auditMetadata).toMatchObject({
      channel: "production",
      rolloutId: "rollout_active",
      releaseEvidenceException
    });
  });

  it.each([
    {
      label: "missing exception",
      command: {}
    },
    {
      label: "mismatched reason",
      command: {
        releaseEvidenceException: {
          type: "production_rolling_abort_stop_rollout" as const,
          targetEnvironment: "production" as const,
          acceptedWithoutReleaseEvidence: true as const,
          reason: "other reason"
        }
      }
    }
  ])("rejects production rolling abort with $label", async ({ command }) => {
    const { client, queries } = releaseRouteClient({ activeRollout: true });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await repository.abortRollingRelease({
      projectId: "project_docs",
      channel: "production",
      actor: { id: "actor-1", name: "Ops", role: "operator" },
      reason: "stop canary",
      idempotencyKey: "rolling-abort-invalid-exception",
      ...command
    });

    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Production rolling abort must record a stop-rollout release evidence exception");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-exception",
        status: "fail"
      })
    ]));
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_route_revisions"))).toBe(false);
    expect(queries.some((query) => query.text.includes("UPDATE siteflow_rolling_releases"))).toBe(false);
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_audit_events"))).toBe(false);
  });

  it.each([
    {
      action: "advance" as const,
      run: (repository: PostgresSiteFlowReadRepository) =>
        repository.advanceRollingRelease({
          projectId: "project_docs",
          channel: "production",
          percentage: 50,
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "advance canary",
          idempotencyKey: "rolling-advance-mismatch",
          releaseEvidence: releaseEvidence()
        })
    },
    {
      action: "complete" as const,
      run: (repository: PostgresSiteFlowReadRepository) =>
        repository.completeRollingRelease({
          projectId: "project_docs",
          channel: "production",
          actor: { id: "actor-1", name: "Ops", role: "operator" },
          reason: "complete canary",
          idempotencyKey: "rolling-complete-mismatch",
          releaseEvidence: releaseEvidence()
        })
    }
  ])("rejects production rolling $action when release evidence does not match the active candidate deployment identity", async ({ run }) => {
    const { client, queries } = releaseRouteClient({ activeRollout: true, sourceRepository: "acme/other" });
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    const result = await run(repository);

    expect(result.status).toBe("rejected");
    expect(result.message).toContain("Release evidence targets");
    expect(result.safetyChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "check-release-evidence-target-identity",
        status: "fail"
      })
    ]));
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_route_revisions"))).toBe(false);
    expect(queries.some((query) => query.text.includes("UPDATE siteflow_rolling_releases"))).toBe(false);
  });

  it("imports vercel.json cron jobs during prebuilt deploy", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-prebuilt-"));
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });

    try {
      const result = await repository.deployPrebuilt({
        projectSlug: "docs",
        requestedHostPrefix: "abc123",
        files: [prebuiltFile("index.html", "<h1>Hello</h1>")],
        crons: [
          {
            path: "/api/revalidate",
            schedule: "0 * * * *"
          }
        ]
      });
      const cronUpsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_cron_jobs"));
      const deploymentInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_deployments"));

      expect(result.previewHost).toBe("abc123.w33d.xyz");
      expect(JSON.parse(String(deploymentInsert?.values?.[9]))).toMatchObject({
        entrypoint: "index.html",
        metadata: {
          routing: {}
        }
      });
      expect(cronUpsert?.values).toEqual([
        expect.stringMatching(/^cron_/),
        "project_docs",
        "vercel:/api/revalidate",
        "/api/revalidate",
        "0 * * * *",
        JSON.stringify({
          id: "siteflow:prebuilt",
          name: "Prebuilt deploy",
          role: "system"
        })
      ]);
      expect(cronUpsert?.text).toContain("ON CONFLICT (project_id, name) DO UPDATE");
      expect(cronUpsert?.text).toContain("status = 'active'");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("publishes prebuilt artifacts through a hidden staging directory", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-prebuilt-atomic-"));
    const client = {
      query: async () => ({ rows: [] }),
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });

    try {
      const result = await repository.deployPrebuilt({
        projectSlug: "docs",
        requestedHostPrefix: "atomic123",
        files: [
          prebuiltFile("index.html", "<h1>Hello</h1>"),
          prebuiltFile("assets/app.js", "console.log('ready');")
        ]
      });
      const rootEntries = await readdir(artifactRoot);

      expect(rootEntries).toEqual([path.basename(result.artifactRoot)]);
      expect(rootEntries.some((entry) => entry.startsWith(".publish-"))).toBe(false);
      await expect(readFile(path.join(result.artifactRoot, "index.html"), "utf8")).resolves.toBe("<h1>Hello</h1>");
      await expect(readFile(path.join(result.artifactRoot, "assets", "app.js"), "utf8")).resolves.toBe("console.log('ready');");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("removes staged prebuilt artifacts when database persistence fails", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-prebuilt-db-fail-"));
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("INSERT INTO siteflow_deployments")) {
          throw new Error("database insert failed");
        }

        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });

    try {
      await expect(repository.deployPrebuilt({
        projectSlug: "docs",
        requestedHostPrefix: "dbfail123",
        files: [prebuiltFile("index.html", "<h1>Hello</h1>")]
      })).rejects.toThrow("database insert failed");

      await expect(readdir(artifactRoot)).resolves.toEqual([]);
      expect(queries.some((query) => query.text === "ROLLBACK")).toBe(true);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("rejects prebuilt deploys over the repository upload budget before database writes", async () => {
    const repository = new PostgresSiteFlowReadRepository({
      connect: async () => {
        throw new Error("database should not be touched");
      }
    } as never, {
      artifactRoot: "/tmp/siteflow",
      baseDomain: "w33d.xyz",
      prebuiltMaxUploadBytes: 4
    });

    await expect(repository.deployPrebuilt({
      projectSlug: "docs",
      files: [prebuiltFile("index.html", "<h1>Hello</h1>")]
    })).rejects.toThrow("SITEFLOW_PREBUILT_MAX_UPLOAD_BYTES");
  });

  it("persists prebuilt clean URL and trailing slash settings in the artifact manifest", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-clean-urls-"));
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });

    try {
      await repository.deployPrebuilt({
        projectSlug: "docs",
        requestedHostPrefix: "clean123",
        files: [prebuiltFile("index.html", "<h1>Hello</h1>")],
        public: true,
        fluid: true,
        images: {
          sizes: [320, 640],
          qualities: [70, 80],
          formats: ["image/webp"],
          minimumCacheTTL: 120,
          dangerouslyAllowSVG: true,
          contentSecurityPolicy: "script-src 'none'; sandbox;",
          contentDispositionType: "inline"
        },
        routing: {
          cleanUrls: true,
          trailingSlash: false,
          skipTrailingSlashRedirect: true
        }
      });
      const deploymentInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_deployments"));

      expect(JSON.parse(String(deploymentInsert?.values?.[9]))).toMatchObject({
        entrypoint: "index.html",
        metadata: {
          public: true,
          fluid: true,
          images: {
            sizes: [320, 640],
            qualities: [70, 80],
            formats: ["image/webp"],
            minimumCacheTTL: 120,
            dangerouslyAllowSVG: true,
            contentSecurityPolicy: "script-src 'none'; sandbox;",
            contentDispositionType: "inline"
          },
          routing: {
            cleanUrls: true,
            trailingSlash: false,
            skipTrailingSlashRedirect: true
          }
        }
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("persists prebuilt source provenance and release evidence in the artifact manifest", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-provenance-"));
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });
    const releaseEvidence = {
      evidencePath: "evidence/release-evidence.json",
      checkedAt: "2026-06-08T12:00:00.000Z",
      status: "passed" as const,
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      releaseTicket: "REL-2026-0608",
      operatorName: "release-operator"
    };

    try {
      await repository.deployPrebuilt({
        projectSlug: "docs",
        requestedHostPrefix: "provenance123",
        files: [prebuiltFile("index.html", "<h1>Hello</h1>")],
        source: {
          repository: "acme/siteflow",
          branch: "main",
          commitSha: "abc123def4567890"
        },
        releaseEvidence
      });
      const deploymentInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_deployments"));
      const manifest = JSON.parse(String(deploymentInsert?.values?.[9]));

      expect(deploymentInsert?.values?.[2]).toBe("main");
      expect(deploymentInsert?.values?.[3]).toBe("abc123def4567890");
      expect(manifest).toMatchObject({
        entrypoint: "index.html",
        metadata: {
          source: {
            repository: "acme/siteflow",
            branch: "main",
            commitSha: "abc123def4567890"
          },
          releaseEvidence
        }
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("derives prebuilt source provenance from release evidence before persisting artifact manifests", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-derived-provenance-"));
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });
    const releaseEvidence = {
      evidencePath: "evidence/release-evidence.json",
      checkedAt: "2026-06-08T12:00:00.000Z",
      status: "passed" as const,
      commitRef: "abc123def4567890",
      repository: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production"
    };

    try {
      await repository.deployPrebuilt({
        projectSlug: "docs",
        requestedHostPrefix: "derived123",
        files: [prebuiltFile("index.html", "<h1>Hello</h1>")],
        releaseEvidence
      });
      const deploymentInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_deployments"));
      const manifest = JSON.parse(String(deploymentInsert?.values?.[9]));

      expect(deploymentInsert?.values?.[2]).toBe("main");
      expect(deploymentInsert?.values?.[3]).toBe("abc123def4567890");
      expect(manifest.metadata.source).toEqual({
        repository: "acme/siteflow",
        branch: "main",
        commitSha: "abc123def4567890"
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("rejects prebuilt source provenance without release evidence before database writes", async () => {
    const repository = new PostgresSiteFlowReadRepository({
      connect: async () => {
        throw new Error("database should not be touched");
      }
    } as never, {
      artifactRoot: "/tmp/siteflow",
      baseDomain: "w33d.xyz"
    });

    await expect(repository.deployPrebuilt({
      projectSlug: "docs",
      requestedHostPrefix: "sourcewithoutrelease123",
      files: [prebuiltFile("index.html", "<h1>Hello</h1>")],
      source: {
        repository: "acme/siteflow",
        branch: "main",
        commitSha: "abc123def4567890"
      }
    })).rejects.toThrow("Prebuilt deploy source requires checked release evidence metadata.");
  });

  it("rejects prebuilt source provenance that conflicts with release evidence before database writes", async () => {
    const repository = new PostgresSiteFlowReadRepository({
      connect: async () => {
        throw new Error("database should not be touched");
      }
    } as never, {
      artifactRoot: "/tmp/siteflow",
      baseDomain: "w33d.xyz"
    });

    await expect(repository.deployPrebuilt({
      projectSlug: "docs",
      requestedHostPrefix: "conflict123",
      files: [prebuiltFile("index.html", "<h1>Hello</h1>")],
      source: {
        repository: "acme/siteflow",
        branch: "main",
        commitSha: "different-commit"
      },
      releaseEvidence: {
        evidencePath: "evidence/release-evidence.json",
        checkedAt: "2026-06-08T12:00:00.000Z",
        status: "passed",
        commitRef: "abc123def4567890",
        repository: "acme/siteflow",
        branch: "main",
        targetEnvironment: "production"
      }
    })).rejects.toThrow("Prebuilt deploy source must match release evidence metadata: commitSha");
  });

  it("rejects raw prebuilt release evidence bundle requests before persisting artifact manifests", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-prebuilt-raw-evidence-"));
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });

    try {
      await expect(
        repository.deployPrebuilt({
          projectSlug: "docs",
          requestedHostPrefix: "rawbundle123",
          files: [prebuiltFile("index.html", "<h1>Hello</h1>")],
          releaseEvidence: {
            evidencePath: "evidence/release-evidence.json",
            bundle: {
              schemaVersion: "siteflow.releaseEvidence.v1",
              name: "siteflow-release-evidence-bundle",
              targetEnvironment: "production"
            }
          }
        })
      ).rejects.toThrow(/unnormalized release evidence bundle/i);

      expect(queries).toHaveLength(0);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("records precompressed prebuilt artifact variants in the artifact manifest", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "siteflow-postgres-precompressed-prebuilt-"));
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot,
      baseDomain: "w33d.xyz"
    });

    try {
      await repository.deployPrebuilt({
        projectSlug: "docs",
        requestedHostPrefix: "assets123",
        files: [
          prebuiltFile("index.html", "<h1>Hello</h1>"),
          prebuiltFile("index.html.br", "brotli bytes"),
          prebuiltFile("index.html.gz", "gzip bytes"),
          prebuiltFile(".siteflow/functions/api/config.json", "{\"secret\":true}"),
          prebuiltFile(".siteflow/functions/api/config.json.br", "function brotli bytes")
        ]
      });
      const deploymentInsert = queries.find((query) => query.text.includes("INSERT INTO siteflow_deployments"));

      expect(JSON.parse(String(deploymentInsert?.values?.[9]))).toMatchObject({
        entrypoint: "index.html",
        fileCount: 5,
        metadata: {
          precompressed: {
            br: 1,
            gzip: 1
          }
        }
      });
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("resolves sealed artifact runtime env from vercel.json metadata and lets project runtime env override it", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("FROM siteflow_artifact_routes")) {
          return {
            rows: [
              {
                host: "abc123.w33d.xyz",
                project_id: "project_docs",
                deployment_id: "dep_runtime_env",
                artifact_root: "/tmp/siteflow/dep_runtime_env",
                entrypoint: "index.html",
                source_branch: "feature/runtime-env",
                production_branch: "main",
                route_channel: "preview",
                rolling_release_id: null,
                percentage: null,
                artifact_manifest: {
                  entrypoint: "index.html",
                  fileCount: 1,
                  totalBytes: 14,
                  checksum: "sha256:runtime",
                  generatedAt: "2026-05-27T00:00:00.000Z",
                  functions: [
                    {
                      path: "/api/env",
                      sourcePath: ".siteflow/functions/api/env.js",
                      runtime: "nodejs20.x",
                      runtimeIsolation: "same_process",
                      handler: "default"
                    }
                  ],
                  metadata: {
                    runtimeEnvKeys: ["PUBLIC_RUNTIME_FLAG", "RUNTIME_SECRET"],
                    sealedRuntimeEnv: {
                      RUNTIME_SECRET: sealSecretValue("artifact-runtime-secret"),
                      PUBLIC_RUNTIME_FLAG: sealSecretValue("artifact-enabled")
                    },
                    routing: {}
                  }
                },
                candidate_deployment_id: null,
                candidate_artifact_root: null,
                candidate_entrypoint: null,
                candidate_project_id: null,
                candidate_source_branch: null,
                candidate_artifact_manifest: null
              }
            ]
          };
        }

        if (text.includes("FROM siteflow_environment_variables")) {
          return {
            rows: [
              {
                key: "RUNTIME_SECRET",
                sealed_value: sealSecretValue("project-runtime-secret")
              }
            ]
          };
        }

        return { rows: [] };
      }
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow",
      baseDomain: "w33d.xyz"
    });
    const route = await repository.resolveArtifactRoute("abc123.w33d.xyz");

    expect(route?.runtimeEnvironment).toEqual({
      RUNTIME_SECRET: "project-runtime-secret",
      PUBLIC_RUNTIME_FLAG: "artifact-enabled"
    });
    expect(route?.functions).toEqual([
      {
        path: "/api/env",
        sourcePath: ".siteflow/functions/api/env.js",
        runtime: "nodejs20.x",
        runtimeIsolation: "same_process",
        handler: "default"
      }
    ]);
    expect(queries.find((query) => query.text.includes("FROM siteflow_environment_variables"))?.values).toEqual([
      "project_docs",
      "preview"
    ]);
  });

  it("enforces operator session idle timeout while resolving principals", async () => {
    const now = new Date("2026-06-07T12:00:00.000Z");
    const secret = "sfs_test_operator_session_secret";
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        return {
          rows: [
            {
              id: "session_ops",
              subject: "ops@example.com",
              actor: {
                id: "user_ops",
                name: "Ops",
                role: "operator"
              },
              token_prefix: "sfs_test_ope",
              scopes: ["read", "write"],
              project_ids: ["project_docs"],
              status: "active",
              created_at: now,
              expires_at: new Date("2026-06-07T13:00:00.000Z"),
              revoked_at: null,
              last_used_at: now
            }
          ]
        };
      }
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow",
      operatorSessionIdleTimeoutSeconds: 900
    });
    const principal = await repository.resolveSessionPrincipal(` ${secret} `, "project_docs");

    expect(principal).toMatchObject({
      kind: "operator_session",
      scopes: ["read", "write"],
      session: {
        id: "session_ops",
        subject: "ops@example.com",
        projectIds: ["project_docs"]
      }
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].text).toContain("COALESCE(last_used_at, created_at) > now() - ($2::integer * interval '1 second')");
    expect(queries[0].text).toContain("FROM siteflow_operator_session_cutoffs");
    expect(queries[0].text).toContain("WHERE project_id IS NULL");
    expect(queries[0].text).toContain("WHERE project_id = $3::text");
    expect(queries[0].values).toEqual([
      `sha256:${createHash("sha256").update(secret).digest("hex")}`,
      900,
      "project_docs"
    ]);
  });

  it("uses the default operator session idle timeout for Postgres session resolution", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        return { rows: [] };
      }
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });

    await repository.resolveSessionPrincipal("sfs_default_idle_timeout");

    expect(queries[0].values?.[1]).toBe(1800);
  });

  it("rotates operator sessions in a transaction while revoking the old token", async () => {
    const now = new Date("2026-06-07T12:00:00.000Z");
    const oldSecret = "sfs_old_operator_session_secret";
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const actor = {
      id: "operator:ops",
      name: "Ops",
      role: "operator" as const
    };
    const currentRow = {
      id: "session_old",
      subject: "ops@example.com",
      actor,
      token_prefix: "sfs_old_oper",
      scopes: ["read", "write"],
      project_ids: ["project_docs"],
      status: "active" as const,
      created_at: now,
      expires_at: new Date("2026-06-07T13:00:00.000Z"),
      revoked_at: null,
      last_used_at: now
    };
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("FROM siteflow_operator_sessions s")) {
          return { rows: [currentRow] };
        }

        if (text.includes("INSERT INTO siteflow_operator_sessions")) {
          return {
            rows: [
              {
                ...currentRow,
                id: values?.[0],
                token_prefix: values?.[4],
                created_at: now,
                last_used_at: null,
                max_age_seconds: 3600
              }
            ]
          };
        }

        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow",
      operatorSessionIdleTimeoutSeconds: 900
    });
    const result = await repository.rotateOperatorSession(oldSecret);
    const selectQuery = queries.find((query) => query.text.includes("FROM siteflow_operator_sessions s"));
    const revokeQuery = queries.find((query) => query.text.includes("UPDATE siteflow_operator_sessions"));
    const insertQuery = queries.find((query) => query.text.includes("INSERT INTO siteflow_operator_sessions"));

    expect(queries[0].text).toBe("BEGIN");
    expect(queries.at(-1)?.text).toBe("COMMIT");
    expect(selectQuery?.text).toContain("FOR UPDATE");
    expect(selectQuery?.text).toContain("COALESCE(last_used_at, created_at) > now() - ($2::integer * interval '1 second')");
    expect(selectQuery?.text).toContain("FROM siteflow_operator_session_cutoffs");
    expect(selectQuery?.values).toEqual([
      `sha256:${createHash("sha256").update(oldSecret).digest("hex")}`,
      900
    ]);
    expect(revokeQuery?.text).toContain("SET status = 'revoked'");
    expect(revokeQuery?.values).toEqual(["session_old"]);
    expect(insertQuery?.values).toEqual([
      expect.stringMatching(/^session_/),
      "ops@example.com",
      JSON.stringify(actor),
      expect.stringMatching(/^sha256:/),
      result?.secret.slice(0, 12),
      ["read", "write"],
      ["project_docs"],
      currentRow.expires_at
    ]);
    expect(result).toMatchObject({
      status: "rotated",
      session: {
        subject: "ops@example.com",
        scopes: ["read", "write"],
        projectIds: ["project_docs"],
        tokenPrefix: result?.secret.slice(0, 12)
      },
      secret: expect.stringMatching(/^sfs_/),
      maxAgeSeconds: 3600,
      message: "Operator session rotated."
    });
  });

  it("rolls back operator session rotation when the old session is invalid", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const result = await repository.rotateOperatorSession("sfs_missing_operator_session");

    expect(result).toBeUndefined();
    expect(queries[0].text).toBe("BEGIN");
    expect(queries.at(-1)?.text).toBe("ROLLBACK");
    expect(queries.some((query) => query.text.includes("INSERT INTO siteflow_operator_sessions"))).toBe(false);
  });

  it("records global operator session revoke-all cutoff evidence", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const actor = { id: "api-token:ops", name: "Ops token", role: "system" as const };
    const cutoffCreatedAt = new Date("2026-06-07T12:30:00.000Z");
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("UPDATE siteflow_operator_sessions")) {
          return { rows: [{ id: "session_1" }, { id: "session_2" }] };
        }

        if (text.includes("INSERT INTO siteflow_operator_session_cutoffs")) {
          return { rows: [{ created_at: cutoffCreatedAt }] };
        }

        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const result = await repository.revokeAllOperatorSessions({
      actor,
      reason: " emergency cutoff "
    });
    const revokeQuery = queries.find((query) => query.text.includes("UPDATE siteflow_operator_sessions"));
    const evidenceQuery = queries.find((query) => query.text.includes("INSERT INTO siteflow_operator_session_cutoffs"));

    expect(queries[0].text).toBe("BEGIN");
    expect(queries.at(-1)?.text).toBe("COMMIT");
    expect(revokeQuery?.text).toContain("WHERE status = 'active'");
    expect(revokeQuery?.text).toContain("AND created_at <= now()");
    expect(revokeQuery?.text).not.toContain("project_ids @>");
    expect(revokeQuery?.values).toEqual([]);
    expect(evidenceQuery?.text).toContain("revoked_count");
    expect(evidenceQuery?.values).toEqual([
      expect.stringMatching(/^sessioncutoff_/),
      null,
      JSON.stringify(actor),
      "emergency cutoff",
      2
    ]);
    expect(result).toEqual({
      status: "revoked",
      scope: "global",
      cutoffId: expect.stringMatching(/^sessioncutoff_/),
      revokedAt: "2026-06-07T12:30:00.000Z",
      revokedCount: 2,
      message: "All existing operator sessions were revoked."
    });
  });

  it("records project operator session revoke-all cutoff evidence without revoking global sessions", async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const actor = { id: "api-token:project-ops", name: "Project ops", role: "operator" as const };
    const cutoffCreatedAt = new Date("2026-06-07T12:45:00.000Z");
    const client = {
      query: async (text: string, values?: unknown[]) => {
        queries.push({ text, values });

        if (text.includes("UPDATE siteflow_operator_sessions")) {
          return { rows: [{ id: "session_project" }] };
        }

        if (text.includes("INSERT INTO siteflow_operator_session_cutoffs")) {
          return { rows: [{ created_at: cutoffCreatedAt }] };
        }

        return { rows: [] };
      },
      release: () => undefined
    };
    const pool = {
      connect: async () => client
    };
    const repository = new PostgresSiteFlowReadRepository(pool as never, {
      artifactRoot: "/tmp/siteflow"
    });
    const result = await repository.revokeAllOperatorSessions({
      projectId: "project_docs",
      actor
    });
    const revokeQuery = queries.find((query) => query.text.includes("UPDATE siteflow_operator_sessions"));
    const evidenceQuery = queries.find((query) => query.text.includes("INSERT INTO siteflow_operator_session_cutoffs"));

    expect(revokeQuery?.text).toContain("WHERE status = 'active'");
    expect(revokeQuery?.text).toContain("project_ids @> ARRAY[$1]::text[]");
    expect(revokeQuery?.text).not.toContain("project_ids IS NULL");
    expect(revokeQuery?.values).toEqual(["project_docs"]);
    expect(evidenceQuery?.values).toEqual([
      expect.stringMatching(/^sessioncutoff_/),
      "project_docs",
      JSON.stringify(actor),
      null,
      1
    ]);
    expect(result).toEqual({
      status: "revoked",
      scope: "project",
      projectId: "project_docs",
      cutoffId: expect.stringMatching(/^sessioncutoff_/),
      revokedAt: "2026-06-07T12:45:00.000Z",
      revokedCount: 1,
      message: "Project operator sessions were revoked."
    });
  });

  it("validates operator session idle timeout configuration", () => {
    expect(() =>
      new PostgresSiteFlowReadRepository({} as never, {
        artifactRoot: "/tmp/siteflow",
        operatorSessionIdleTimeoutSeconds: 60
      })
    ).not.toThrow();
    expect(() =>
      new PostgresSiteFlowReadRepository({} as never, {
        artifactRoot: "/tmp/siteflow",
        operatorSessionIdleTimeoutSeconds: 86_400
      })
    ).not.toThrow();
    expect(() =>
      new PostgresSiteFlowReadRepository({} as never, {
        artifactRoot: "/tmp/siteflow",
        operatorSessionIdleTimeoutSeconds: 59
      })
    ).toThrow("Operator session idle timeout seconds");
    expect(() =>
      new PostgresSiteFlowReadRepository({} as never, {
        artifactRoot: "/tmp/siteflow",
        operatorSessionIdleTimeoutSeconds: 86_401
      })
    ).toThrow("Operator session idle timeout seconds");
    expect(() =>
      new PostgresSiteFlowReadRepository({} as never, {
        artifactRoot: "/tmp/siteflow",
        operatorSessionIdleTimeoutSeconds: 900.5
      })
    ).toThrow("Operator session idle timeout seconds");
  });
});
