import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  evaluateIngressEvidence,
  runIngressEvidenceCheckCli
} from "./ingressEvidenceCheck";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function validEvidence(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "siteflow.ingressEvidence.v1",
    name: "siteflow-ingress-evidence",
    status: "passed",
    dryRun: false,
    checkedAt: "2026-06-08T11:30:00.000Z",
    environment: "production",
    publicBaseUrl: "https://siteflow.example.com",
    release: {
      commitRef: "abc123",
      repository: "acme/siteflow",
      branch: "main"
    },
    target: {
      environment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      directApiUrl: "http://203.0.113.10:8787/healthz",
      release: {
        commitRef: "abc123",
        repository: "acme/siteflow",
        branch: "main"
      }
    },
    trustProxyPolicy: "loopback",
    deploymentTopology: {
      apiInstanceCount: 2,
      apiProcessCount: 2,
      ingressCount: 1
    },
    directApiPort: {
      status: "blocked",
      checked: true,
      reachable: false,
      checkedAt: "2026-06-08T11:31:00.000Z",
      target: "http://203.0.113.10:8787/healthz"
    },
    forwardedHeaders: {
      status: "passed",
      checkedAt: "2026-06-08T11:32:00.000Z",
      xForwardedForOverwritten: true,
      xForwardedHostOverwritten: true,
      xForwardedProtoOverwritten: true,
      proxyAddXForwardedForUsed: false
    },
    proxySourcePolicy: {
      status: "passed",
      checkedAt: "2026-06-08T11:33:00.000Z",
      configured: "loopback",
      finalHopMatched: true,
      allSourcesTrusted: false
    },
    apiRateLimit: {
      status: "limited",
      checkedAt: "2026-06-08T11:34:00.000Z",
      path: "/api/projects",
      rateLimitedStatusCode: 429,
      clientIpBucketed: true,
      edgeEnforced: true
    },
    unthrottledRoutes: {
      status: "passed",
      checkedAt: "2026-06-08T11:35:00.000Z",
      healthz: { statusCode: 200, rateLimited: false },
      readyz: { statusCode: 200, rateLimited: false },
      metrics: { statusCode: 401, rateLimited: false },
      preview: { statusCode: 200, rateLimited: false },
      static: { statusCode: 200, rateLimited: false }
    },
    operatorName: "Platform Operator",
    ticketId: "CHG-123",
    ...overrides
  };
}

describe("ingressEvidenceCheck", () => {
  it("passes complete target ingress evidence", () => {
    const result = evaluateIngressEvidence(validEvidence(), {
      evidencePath: "ingress-evidence.json",
      targetEnvironment: "production",
      now
    });

    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    expect(result.selectedEvidence).toMatchObject({
      environment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      commitRef: "abc123",
      repository: "acme/siteflow",
      branch: "main",
      trustProxyPolicy: "loopback",
      deploymentTopology: {
        apiInstanceCount: 2,
        apiProcessCount: 2,
        ingressCount: 1
      },
      apiRateLimit: {
        edgeEnforced: true
      },
      metricsAccessControl: null
    });
  });

  it("passes and summarizes optional metrics private-scrape access-control evidence", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        metricsAccessControl: {
          status: "passed",
          checkedAt: "2026-06-08T11:36:00.000Z",
          privateScrapeException: true,
          scrapePath: "/metrics",
          protection: "reverse_proxy_allowlist",
          publicAccessBlocked: true,
          evidenceLocation: "CHG-123#metrics-private-scrape"
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        targetEnvironment: "production",
        now
      }
    );

    expect(result.status).toBe("passed");
    expect(result.selectedEvidence.metricsAccessControl).toMatchObject({
      status: "passed",
      timestamp: "2026-06-08T11:36:00.000Z",
      privateScrapeException: true,
      scrapePath: "/metrics",
      protection: "reverse_proxy_allowlist",
      publicAccessBlocked: true
    });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "metrics_access_control_optional", status: "pass" }),
        expect.objectContaining({ name: "metrics_access_control_age", status: "pass" }),
        expect.objectContaining({ name: "metrics_access_control_private_scrape", status: "pass" })
      ])
    );
  });

  it("blocks malformed metrics private-scrape access-control evidence when provided", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        metricsAccessControl: {
          status: "passed",
          checkedAt: "2026-06-08T11:36:00.000Z",
          privateScrapeException: true,
          scrapePath: "/metrics",
          protection: "public",
          publicAccessBlocked: false
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "metrics_access_control_private_scrape",
          status: "fail"
        })
      ])
    );
  });

  it("blocks schema version or release identity mismatch", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        schemaVersion: "siteflow.ingressEvidence.v0",
        release: {
          commitRef: "abc123",
          repository: "acme/siteflow",
          branch: "main"
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        commitRef: "different",
        repo: "acme/siteflow",
        branch: "main",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "schema_version",
          status: "fail"
        }),
        expect.objectContaining({
          name: "release_identity",
          status: "fail"
        })
      ])
    );
  });

  it("blocks evidence from a different target environment", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        environment: "staging"
      }),
      {
        evidencePath: "ingress-evidence.json",
        targetEnvironment: "production",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "environment", status: "fail" })
      ])
    );
  });

  it("blocks evidence with missing or mismatched target facts", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        target: {
          environment: "production",
          publicBaseUrl: "https://siteflow.example.com",
          directApiUrl: "http://198.51.100.15:8787/healthz",
          release: {
            commitRef: "abc123",
            repository: "acme/siteflow",
            branch: "main"
          }
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "target_facts", status: "fail" })
      ])
    );
  });

  it("does not treat top-level blocked evidence as passing", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        status: "blocked"
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "evidence_status",
          status: "fail"
        })
      ])
    );
  });

  it("blocks template evidence explicitly", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        template: true
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "not_template",
          status: "fail"
        })
      ])
    );
  });

  it("requires final passed status instead of passing aliases", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        status: "healthy"
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "evidence_status",
          status: "pass"
        }),
        expect.objectContaining({
          name: "status_final",
          status: "fail"
        })
      ])
    );
  });

  it("blocks raw secret-like values in operator-provided ingress evidence", () => {
    const evidence = validEvidence();
    const forwardedHeaders = evidence.forwardedHeaders as Record<string, unknown>;
    forwardedHeaders.authorization = "Bearer abcdefghijklmnop";
    const result = evaluateIngressEvidence(evidence, {
      evidencePath: "ingress-evidence.json",
      now
    });
    const serialized = JSON.stringify(result);

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "no_sensitive_evidence_values", status: "fail" })
      ])
    );
    expect(serialized).not.toContain("abcdefghijklmnop");
  });

  it("blocks direct API port exposure", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        directApiPort: {
          status: "reachable",
          checked: true,
          reachable: true,
          checkedAt: "2026-06-08T11:31:00.000Z"
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "direct_api_port_blocked",
          status: "fail"
        })
      ])
    );
  });

  it("blocks unsanitized forwarded headers", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        forwardedHeaders: {
          status: "passed",
          checkedAt: "2026-06-08T11:32:00.000Z",
          xForwardedForOverwritten: false,
          xForwardedHostOverwritten: true,
          xForwardedProtoOverwritten: true,
          proxyAddXForwardedForUsed: true
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "forwarded_headers_overwritten",
          status: "fail"
        })
      ])
    );
  });

  it("blocks all-source trusted proxy policies", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        trustProxyPolicy: "0.0.0.0/0",
        proxySourcePolicy: {
          status: "passed",
          checkedAt: "2026-06-08T11:33:00.000Z",
          configured: "0.0.0.0/0",
          finalHopMatched: true,
          allSourcesTrusted: true
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "proxy_source_policy_allowed",
          status: "fail"
        }),
        expect.objectContaining({
          name: "proxy_source_policy_matches",
          status: "fail"
        })
      ])
    );
  });

  it("blocks malformed trusted proxy IP and CIDR entries", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        trustProxyPolicy: "999.999.999.999/99,2001:::1/999",
        proxySourcePolicy: {
          status: "passed",
          checkedAt: "2026-06-08T11:33:00.000Z",
          configured: "999.999.999.999/99,2001:::1/999",
          finalHopMatched: true,
          allSourcesTrusted: false
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "proxy_source_policy_allowed",
          status: "fail"
        })
      ])
    );
  });

  it("blocks missing API 429 evidence", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        apiRateLimit: {
          status: "passed",
          checkedAt: "2026-06-08T11:34:00.000Z",
          statusCode: 200,
          clientIpBucketed: true
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "api_rate_limit_429",
          status: "fail"
        })
      ])
    );
  });

  it("accepts shared limiter scope as multi-instance API rate-limit proof", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        apiRateLimit: {
          status: "limited",
          checkedAt: "2026-06-08T11:34:00.000Z",
          path: "/api/projects",
          rateLimitedStatusCode: 429,
          limiterScope: "shared"
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("passed");
    expect(result.selectedEvidence.apiRateLimit).toMatchObject({
      limiterScope: "shared"
    });
  });

  it("accepts explicit single-context topology flags", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        deploymentTopology: {
          multiInstance: false,
          multiProcess: false,
          multiIngress: false
        },
        apiRateLimit: {
          status: "limited",
          checkedAt: "2026-06-08T11:34:00.000Z",
          path: "/api/projects",
          rateLimitedStatusCode: 429,
          clientIpBucketed: true,
          processLocalOnly: true
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("passed");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "deployment_topology_present",
          status: "pass"
        }),
        expect.objectContaining({
          name: "api_rate_limit_topology",
          status: "pass"
        })
      ])
    );
  });

  it.each([
    {
      label: "only ingressCount",
      deploymentTopology: {
        ingressCount: 1
      }
    },
    {
      label: "mode only",
      deploymentTopology: {
        mode: "single"
      }
    }
  ])("blocks incomplete deployment topology with $label", ({ deploymentTopology }) => {
    const result = evaluateIngressEvidence(
      validEvidence({
        deploymentTopology
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "deployment_topology_present",
          status: "fail"
        }),
        expect.objectContaining({
          name: "api_rate_limit_topology",
          status: "fail"
        })
      ])
    );
  });

  it("blocks evidence that omits deployment topology", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        deploymentTopology: undefined
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.selectedEvidence.deploymentTopology).toBeNull();
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "deployment_topology_present",
          status: "fail"
        }),
        expect.objectContaining({
          name: "api_rate_limit_topology",
          status: "fail"
        })
      ])
    );
  });

  it("blocks multi-instance process-local API rate limiting", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        deploymentTopology: {
          apiInstanceCount: 2,
          apiProcessCount: 1,
          ingressCount: 1
        },
        apiRateLimit: {
          status: "limited",
          checkedAt: "2026-06-08T11:34:00.000Z",
          path: "/api/projects",
          rateLimitedStatusCode: 429,
          clientIpBucketed: true,
          processLocalOnly: true
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.selectedEvidence.apiRateLimit).toMatchObject({
      processLocalOnly: true,
      clientIpBucketed: true
    });
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "deployment_topology_present",
          status: "pass"
        }),
        expect.objectContaining({
          name: "api_rate_limit_topology",
          status: "fail"
        })
      ])
    );
  });

  it("blocks non-API route evidence with server errors", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        unthrottledRoutes: {
          status: "passed",
          checkedAt: "2026-06-08T11:35:00.000Z",
          healthz: { statusCode: 500, rateLimited: false },
          readyz: { statusCode: 200, rateLimited: false },
          metrics: { statusCode: 401, rateLimited: false },
          preview: { statusCode: 200, rateLimited: false },
          static: { statusCode: 200, rateLimited: false }
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "unthrottled_routes_not_limited",
          status: "fail"
        })
      ])
    );
  });

  it("blocks stale evidence and missing non-API route checks", () => {
    const result = evaluateIngressEvidence(
      validEvidence({
        checkedAt: "2026-06-01T11:30:00.000Z",
        unthrottledRoutes: {
          status: "passed",
          checkedAt: "2026-06-08T11:35:00.000Z",
          healthz: { statusCode: 200, rateLimited: false },
          readyz: { statusCode: 200, rateLimited: false },
          metrics: { statusCode: 429, rateLimited: true }
        }
      }),
      {
        evidencePath: "ingress-evidence.json",
        now,
        maxAgeHours: 24
      }
    );

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "evidence_age",
          status: "fail"
        }),
        expect.objectContaining({
          name: "unthrottled_routes_not_limited",
          status: "fail"
        })
      ])
    );
  });

  it("runs the CLI with JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-evidence-"));
    const evidencePath = path.join(root, "ingress-evidence.json");
    const stdout = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
        return true;
      }
    };
    const stderr = {
      value: "",
      write(chunk: string) {
        this.value += chunk;
        return true;
      }
    };

    try {
      const timestamp = new Date().toISOString();

      const evidence = validEvidence({
        checkedAt: timestamp,
        directApiPort: {
          status: "blocked",
          checked: true,
          reachable: false,
          checkedAt: timestamp,
          target: "http://203.0.113.10:8787/healthz"
        },
        forwardedHeaders: {
          status: "passed",
          checkedAt: timestamp,
          xForwardedForOverwritten: true,
          xForwardedHostOverwritten: true,
          xForwardedProtoOverwritten: true,
          proxyAddXForwardedForUsed: false
        },
        proxySourcePolicy: {
          status: "passed",
          checkedAt: timestamp,
          configured: "loopback",
          finalHopMatched: true,
          allSourcesTrusted: false
        },
        apiRateLimit: {
          status: "limited",
          checkedAt: timestamp,
          path: "/api/projects",
          rateLimitedStatusCode: 429,
          clientIpBucketed: true,
          edgeEnforced: true
        },
        unthrottledRoutes: {
          status: "passed",
          checkedAt: timestamp,
          healthz: { statusCode: 200, rateLimited: false },
          readyz: { statusCode: 200, rateLimited: false },
          metrics: { statusCode: 401, rateLimited: false },
          preview: { statusCode: 200, rateLimited: false },
          static: { statusCode: 200, rateLimited: false }
        }
      });

      await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");

      const exitCode = await runIngressEvidenceCheckCli(
        [
          "--evidence", evidencePath,
          "--commit-ref", "abc123",
          "--repo", "acme/siteflow",
          "--branch", "main",
          "--json"
        ],
        { stdout, stderr }
      );
      const result = JSON.parse(stdout.value);

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");
      expect(result).toMatchObject({
        name: "siteflow-ingress-evidence-check",
        status: "passed",
        evidencePath
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
