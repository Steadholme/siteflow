import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectIngressEvidence,
  parseIngressEvidenceCollectArgs,
  runIngressEvidenceCollectCli,
  type IngressEvidenceFetch
} from "./ingressEvidenceCollect";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function textResponse(status: number, body: string) {
  return {
    status,
    json: async () => JSON.parse(body || "{}"),
    text: async () => body
  };
}

function baseOptions(overrides: Partial<Parameters<typeof collectIngressEvidence>[0]> = {}) {
  return {
    publicBaseUrl: "https://siteflow.example.com",
    directApiUrl: "http://10.0.0.5:8787/healthz",
    environment: "production",
    commitRef: "abc123",
    repo: "acme/siteflow",
    branch: "main",
    trustProxyPolicy: "loopback",
    operatorName: "Platform Operator",
    ticketId: "CHG-123",
    rateLimitAttempts: 6,
    forwardedHeaderEchoUrl: "https://siteflow.example.com/_siteflow/echo-headers",
    proxyFinalHopMatched: true,
    apiInstanceCount: 2,
    apiProcessCount: 2,
    ingressCount: 1,
    apiRateLimitEdgeEnforced: true,
    fetchImpl: makeFetch().fetchImpl,
    now,
    ...overrides
  };
}

function operatorIngressEvidence() {
  return {
    forwardedHeaders: {
      status: "passed",
      checkedAt: "2026-06-08T12:00:00.000Z",
      xForwardedForOverwritten: true,
      xForwardedHostOverwritten: true,
      xForwardedProtoOverwritten: true,
      proxyAddXForwardedForUsed: false
    },
    proxySourcePolicy: {
      status: "passed",
      checkedAt: "2026-06-08T12:00:00.000Z",
      configured: "loopback",
      finalHopMatched: true,
      allSourcesTrusted: false
    },
    deploymentTopology: {
      apiInstanceCount: 2,
      apiProcessCount: 2,
      ingressCount: 1
    },
    apiRateLimit: {
      edgeEnforced: true,
      enforcementPoint: "ingress"
    }
  };
}

function makeFetch(options: { directReachable?: boolean; rateLimited?: boolean; routeFailure?: boolean; echoSecret?: boolean } = {}) {
  const calls: Array<{ input: string; init?: { method?: string; headers?: Record<string, string> } }> = [];
  let apiCalls = 0;
  const fetchImpl: IngressEvidenceFetch = async (input, init) => {
    calls.push({ input, init });

    if (input === "http://10.0.0.5:8787/healthz") {
      if (options.directReachable) {
        return textResponse(200, "ok");
      }

      throw new Error("direct port blocked");
    }

    const url = new URL(input);

    if (url.pathname === "/_siteflow/echo-headers") {
      return jsonResponse(200, {
        headers: {
          "x-forwarded-for": options.echoSecret ? "Bearer abcdefghijklmnop" : "198.51.100.24",
          "x-forwarded-host": "siteflow.example.com",
          "x-forwarded-proto": "https"
        }
      });
    }

    if (url.pathname === "/api/projects") {
      apiCalls += 1;
      return textResponse(options.rateLimited === false || apiCalls < 4 ? 401 : 429, "");
    }

    if (url.pathname === "/metrics") {
      return textResponse(options.routeFailure ? 429 : 401, "");
    }

    if (url.pathname === "/healthz" || url.pathname === "/readyz" || url.pathname === "/" || url.pathname === "/index.html") {
      return textResponse(options.routeFailure ? 500 : 200, "ok");
    }

    return textResponse(404, "not found");
  };

  return { fetchImpl, calls };
}

describe("ingressEvidenceCollect", () => {
  it("collects target ingress evidence and writes checker output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-collect-"));
    const { fetchImpl, calls } = makeFetch();

    try {
      const outputPath = path.join(root, "ingress-evidence-raw.json");
      const checkOutputPath = path.join(root, "ingress-evidence.json");
      const result = await collectIngressEvidence(baseOptions({
        outputPath,
        checkOutputPath,
        fetchImpl
      }));
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));
      const serialized = JSON.stringify(result);
      const rateLimitCalls = calls.filter((call) => new URL(call.input).pathname === "/api/projects");

      expect(result.status).toBe("collected");
      expect(result.exitCode).toBe(0);
      expect(raw).toMatchObject({
        schemaVersion: "siteflow.ingressEvidence.v1",
        name: "siteflow-ingress-evidence",
        status: "passed",
        dryRun: false,
        directApiPort: {
          status: "blocked",
          checked: true,
          reachable: false
        },
        forwardedHeaders: {
          status: "passed",
          xForwardedForOverwritten: true,
          xForwardedHostOverwritten: true,
          xForwardedProtoOverwritten: true,
          proxyAddXForwardedForUsed: false
        },
        deploymentTopology: {
          apiInstanceCount: 2,
          apiProcessCount: 2,
          ingressCount: 1
        },
        apiRateLimit: {
          status: "limited",
          rateLimitedStatusCode: 429,
          clientIpBucketed: true,
          spoofedXForwardedForIgnored: true,
          edgeEnforced: true
        },
        unthrottledRoutes: {
          status: "passed",
          metrics: {
            statusCode: 401,
            rateLimited: false
          }
        }
      });
      expect(check).toMatchObject({
        name: "siteflow-ingress-evidence-check",
        status: "passed",
        exitCode: 0
      });
      expect(rateLimitCalls.length).toBe(4);
      expect(rateLimitCalls.map((call) => call.init?.headers?.["x-forwarded-for"])).toEqual([
        "203.0.113.10",
        "203.0.113.11",
        "203.0.113.12",
        "203.0.113.13"
      ]);
      expect(calls.find((call) => new URL(call.input).pathname === "/_siteflow/echo-headers")?.init?.headers).toMatchObject({
        "x-forwarded-host": "spoofed.siteflow.invalid",
        "x-forwarded-proto": "http"
      });
      expect(serialized).not.toContain("spoofed.siteflow.invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses operator evidence for forwarded headers and proxy final-hop proof when no echo endpoint is available", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-operator-"));

    try {
      const operatorEvidencePath = path.join(root, "operator-ingress.json");

      await writeFile(operatorEvidencePath, `${JSON.stringify(operatorIngressEvidence(), null, 2)}\n`, "utf8");

      const result = await collectIngressEvidence(baseOptions({
        forwardedHeaderEchoUrl: undefined,
        proxyFinalHopMatched: undefined,
        apiInstanceCount: undefined,
        apiProcessCount: undefined,
        ingressCount: undefined,
        apiRateLimitEdgeEnforced: undefined,
        operatorEvidencePath
      }));

      expect(result.status).toBe("collected");
      expect(result.checkResult).toMatchObject({
        status: "passed",
        exitCode: 0
      });
      expect(result.evidence).toMatchObject(operatorIngressEvidence());
      expect(result.checkResult?.selectedEvidence).toMatchObject({
        deploymentTopology: {
          apiInstanceCount: 2,
          apiProcessCount: 2,
          ingressCount: 1
        },
        apiRateLimit: {
          edgeEnforced: true,
          enforcementPoint: "ingress"
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects operator evidence templates before merging them into collected evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-operator-template-"));

    try {
      const operatorEvidencePath = path.join(root, "operator-ingress-template.json");

      await writeFile(
        operatorEvidencePath,
        `${JSON.stringify({
          ...operatorIngressEvidence(),
          status: "blocked",
          dryRun: true,
          template: true
        }, null, 2)}\n`,
        "utf8"
      );

      await expect(collectIngressEvidence(baseOptions({
        forwardedHeaderEchoUrl: undefined,
        proxyFinalHopMatched: undefined,
        apiInstanceCount: undefined,
        apiProcessCount: undefined,
        ingressCount: undefined,
        apiRateLimitEdgeEnforced: undefined,
        operatorEvidencePath
      }))).rejects.toThrow(/operator evidence template/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks raw secret-like operator evidence before writing collector outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-operator-secret-"));

    try {
      const operatorEvidencePath = path.join(root, "operator-ingress.json");
      const outputPath = path.join(root, "ingress-evidence-raw.json");
      const checkOutputPath = path.join(root, "ingress-evidence.json");
      const operator = operatorIngressEvidence();
      operator.forwardedHeaders = {
        ...(operator.forwardedHeaders as Record<string, unknown>),
        authorization: "Bearer abcdefghijklmnop"
      };

      await writeFile(operatorEvidencePath, `${JSON.stringify(operator, null, 2)}\n`, "utf8");

      const result = await collectIngressEvidence(baseOptions({
        forwardedHeaderEchoUrl: undefined,
        proxyFinalHopMatched: undefined,
        apiInstanceCount: undefined,
        apiProcessCount: undefined,
        ingressCount: undefined,
        apiRateLimitEdgeEnforced: undefined,
        operatorEvidencePath,
        outputPath,
        checkOutputPath
      }));
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("blocked");
      expect(result.evidence).toBeUndefined();
      expect(result.checkResult).toBeUndefined();
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "no_sensitive_evidence_values", status: "fail" })
        ])
      );
      await expect(readFile(outputPath, "utf8")).rejects.toThrow();
      await expect(readFile(checkOutputPath, "utf8")).rejects.toThrow();
      expect(serialized).not.toContain("abcdefghijklmnop");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks raw secret-like forwarded-header echo output before writing collector outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-echo-secret-"));

    try {
      const outputPath = path.join(root, "ingress-evidence-raw.json");
      const checkOutputPath = path.join(root, "ingress-evidence.json");
      const result = await collectIngressEvidence(baseOptions({
        outputPath,
        checkOutputPath,
        fetchImpl: makeFetch({ echoSecret: true }).fetchImpl
      }));
      const serialized = JSON.stringify(result);

      expect(result.status).toBe("blocked");
      expect(result.evidence).toBeUndefined();
      expect(result.checkResult).toBeUndefined();
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "no_sensitive_evidence_values", status: "fail" })
        ])
      );
      await expect(readFile(outputPath, "utf8")).rejects.toThrow();
      await expect(readFile(checkOutputPath, "utf8")).rejects.toThrow();
      expect(serialized).not.toContain("abcdefghijklmnop");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets CLI operator evidence provide proxy proof when no proxy flag is passed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-cli-operator-"));
    let stdout = "";
    let stderr = "";

    try {
      const operatorEvidencePath = path.join(root, "operator-ingress.json");

      await writeFile(operatorEvidencePath, `${JSON.stringify(operatorIngressEvidence(), null, 2)}\n`, "utf8");

      const exitCode = await runIngressEvidenceCollectCli(
        [
          "--public-base-url", "https://siteflow.example.com",
          "--direct-api-url", "http://10.0.0.5:8787/healthz",
          "--target-environment", "production",
          "--commit-ref", "abc123",
          "--repo", "acme/siteflow",
          "--branch", "main",
          "--trust-proxy-policy", "loopback",
          "--operator-name", "Platform Operator",
          "--release-ticket", "CHG-123",
          "--operator-evidence", operatorEvidencePath,
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        {
          fetchImpl: makeFetch().fetchImpl,
          now
        }
      );
      const printed = JSON.parse(stdout);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(printed).toMatchObject({
        status: "passed",
        proxySourcePolicy: {
          finalHopMatched: true,
          allSourcesTrusted: false
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when deployment topology is not provided by CLI options or operator evidence", async () => {
    const result = await collectIngressEvidence(baseOptions({
      apiInstanceCount: undefined,
      apiProcessCount: undefined,
      ingressCount: undefined,
      apiRateLimitEdgeEnforced: undefined
    }));

    expect(result.status).toBe("blocked");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "deployment_topology_collected",
          status: "fail"
        }),
        expect.objectContaining({
          name: "api_rate_limit_topology_collected",
          status: "fail"
        }),
        expect.objectContaining({
          name: "ingress_evidence_check",
          status: "fail"
        })
      ])
    );
    expect(result.checkResult?.checks).toEqual(
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

  it("blocks and writes blocked raw evidence when active target probes fail", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-blocked-"));
    const outputPath = path.join(root, "ingress-evidence-raw.json");

    try {
      const result = await collectIngressEvidence(baseOptions({
        outputPath,
        fetchImpl: makeFetch({
          directReachable: true,
          rateLimited: false,
          routeFailure: true
        }).fetchImpl
      }));
      const raw = JSON.parse(await readFile(outputPath, "utf8"));

      expect(result.status).toBe("blocked");
      expect(result.exitCode).toBe(1);
      expect(raw.status).toBe("blocked");
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "direct_api_port_collected",
            status: "fail"
          }),
          expect.objectContaining({
            name: "api_rate_limit_collected",
            status: "fail"
          }),
          expect.objectContaining({
            name: "ingress_evidence_check",
            status: "fail"
          })
        ])
      );
      expect(result.checkResult?.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "direct_api_port_blocked",
            status: "fail"
          }),
          expect.objectContaining({
            name: "api_rate_limit_429",
            status: "fail"
          })
        ])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs the CLI and writes raw and checker outputs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-cli-"));
    let stdout = "";
    let stderr = "";

    try {
      const outputPath = path.join(root, "ingress-evidence-raw.json");
      const checkOutputPath = path.join(root, "ingress-evidence.json");
      const exitCode = await runIngressEvidenceCollectCli(
        [
          "--public-base-url", "https://siteflow.example.com",
          "--direct-api-url", "http://10.0.0.5:8787/healthz",
          "--target-environment", "production",
          "--commit-ref", "abc123",
          "--repo", "acme/siteflow",
          "--branch", "main",
          "--trust-proxy-policy", "loopback",
          "--operator-name", "Platform Operator",
          "--release-ticket", "CHG-123",
          "--forwarded-header-echo-url", "https://siteflow.example.com/_siteflow/echo-headers",
          "--proxy-final-hop-matched",
          "--api-instance-count", "2",
          "--api-process-count", "2",
          "--ingress-count", "1",
          "--api-rate-limit-edge-enforced",
          "--output", outputPath,
          "--check-output", checkOutputPath,
          "--json"
        ],
        {
          stdout: { write: (chunk: string) => ((stdout += chunk), true) },
          stderr: { write: (chunk: string) => ((stderr += chunk), true) }
        },
        {
          fetchImpl: makeFetch().fetchImpl,
          now
        }
      );
      const printed = JSON.parse(stdout);
      const raw = JSON.parse(await readFile(outputPath, "utf8"));
      const check = JSON.parse(await readFile(checkOutputPath, "utf8"));

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(printed).toEqual(raw);
      expect(check).toMatchObject({
        status: "passed",
        exitCode: 0
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns usage errors for missing required options and invalid probe settings", () => {
    expect(parseIngressEvidenceCollectArgs([
      "--public-base-url", "https://siteflow.example.com",
      "--direct-api-url", "http://10.0.0.5:8787/healthz",
      "--target-environment", "production",
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--trust-proxy-policy", "loopback",
      "--operator-name", "Platform Operator",
      "--release-ticket", "CHG-123",
      "--api-instance-count", "2",
      "--api-process-count", "2",
      "--ingress-count", "1",
      "--api-rate-limit-edge-enforced",
      "--api-rate-limit-enforcement-point", "ingress"
    ])).toMatchObject({
      apiInstanceCount: 2,
      apiProcessCount: 2,
      ingressCount: 1,
      apiRateLimitEdgeEnforced: true,
      apiRateLimitEnforcementPoint: "ingress"
    });
    expect(() => parseIngressEvidenceCollectArgs([])).toThrow("--public-base-url <url> is required");
    expect(() => parseIngressEvidenceCollectArgs([
      "--public-base-url", "http://siteflow.example.com",
      "--direct-api-url", "http://10.0.0.5:8787/healthz",
      "--target-environment", "production",
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--trust-proxy-policy", "loopback",
      "--operator-name", "Platform Operator",
      "--release-ticket", "CHG-123"
    ])).toThrow("--public-base-url must use https");
    expect(() => parseIngressEvidenceCollectArgs([
      "--public-base-url", "https://siteflow.example.com",
      "--direct-api-url", "http://10.0.0.5:8787/healthz",
      "--target-environment", "production",
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--trust-proxy-policy", "loopback",
      "--operator-name", "Platform Operator",
      "--release-ticket", "CHG-123",
      "--api-rate-limit-path", "api/projects"
    ])).toThrow("--api-rate-limit-path must start with '/'");
    expect(() => parseIngressEvidenceCollectArgs([
      "--public-base-url", "https://siteflow.example.com",
      "--direct-api-url", "http://10.0.0.5:8787/healthz",
      "--target-environment", "production",
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--trust-proxy-policy", "loopback",
      "--operator-name", "Platform Operator",
      "--release-ticket", "CHG-123",
      "--api-instance-count", "0"
    ])).toThrow("--api-instance-count must be a positive number");
  });
});
