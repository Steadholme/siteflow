import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectIngressEvidence, type IngressEvidenceFetch } from "./ingressEvidenceCollect";
import { evaluateIngressEvidence } from "./ingressEvidenceCheck";
import {
  createIngressOperatorEvidenceTemplate,
  parseIngressOperatorEvidenceTemplateArgs,
  runIngressOperatorEvidenceTemplateCli,
  writeIngressOperatorEvidenceTemplate
} from "./ingressOperatorEvidenceTemplate";

const now = () => new Date("2026-06-08T12:00:00.000Z");

const baseOptions = {
  commitRef: "abc123",
  repo: "acme/siteflow",
  branch: "main",
  targetEnvironment: "production",
  publicBaseUrl: "https://siteflow.example.com",
  trustProxyPolicy: "loopback",
  operatorName: "Platform Operator",
  ticketId: "CHG-123",
  now
};

function textResponse(status: number, body: string) {
  return {
    status,
    json: async () => JSON.parse(body || "{}"),
    text: async () => body
  };
}

function makeFetch() {
  let apiCalls = 0;
  const fetchImpl: IngressEvidenceFetch = async (input) => {
    if (input === "http://10.0.0.5:8787/healthz") {
      throw new Error("direct port blocked");
    }

    const url = new URL(input);

    if (url.pathname === "/api/projects") {
      apiCalls += 1;
      return textResponse(apiCalls < 4 ? 401 : 429, "");
    }

    if (url.pathname === "/metrics") {
      return textResponse(401, "");
    }

    if (url.pathname === "/healthz" || url.pathname === "/readyz" || url.pathname === "/" || url.pathname === "/index.html") {
      return textResponse(200, "ok");
    }

    return textResponse(404, "not found");
  };

  return fetchImpl;
}

function filledOperatorEvidence() {
  const template = createIngressOperatorEvidenceTemplate(baseOptions);

  return {
    ...template,
    status: "passed",
    dryRun: false,
    template: false,
    forwardedHeaders: {
      ...template.forwardedHeaders,
      status: "passed",
      xForwardedForOverwritten: true,
      xForwardedHostOverwritten: true,
      xForwardedProtoOverwritten: true,
      proxyAddXForwardedForUsed: false,
      observationSource: "target echo endpoint",
      evidenceLocation: "CHG-123#ingress-forwarded-headers"
    },
    proxySourcePolicy: {
      ...template.proxySourcePolicy,
      status: "passed",
      configured: "loopback",
      finalHopMatched: true,
      allSourcesTrusted: false,
      finalHopSource: "127.0.0.1",
      evidenceLocation: "CHG-123#ingress-final-hop"
    },
    deploymentTopology: {
      ...template.deploymentTopology,
      status: "passed",
      apiInstanceCount: 2,
      apiProcessCount: 2,
      ingressCount: 1,
      multiInstance: true,
      multiProcess: true,
      multiIngress: false,
      mode: "multi_instance",
      evidenceLocation: "CHG-123#ingress-topology"
    },
    apiRateLimit: {
      ...template.apiRateLimit,
      status: "passed",
      edgeEnforced: true,
      sharedAcrossInstances: true,
      processLocalOnly: false,
      limiterScope: "edge",
      limiterType: "shared",
      enforcementPoint: "ingress",
      evidenceLocation: "CHG-123#ingress-rate-limit"
    },
    operator: {
      ...template.operator,
      status: "passed",
      ticketUrl: "https://changes.example.com/CHG-123",
      reviewedBy: "Release Manager"
    }
  };
}

describe("ingressOperatorEvidenceTemplate", () => {
  it("creates a blocked dry-run raw operator-evidence template with safe todo sections", () => {
    const template = createIngressOperatorEvidenceTemplate(baseOptions);
    const serialized = JSON.stringify(template);

    expect(template).toMatchObject({
      schemaVersion: "siteflow.ingressOperatorEvidence.v1",
      name: "siteflow-ingress-operator-evidence-template",
      status: "blocked",
      dryRun: true,
      template: true,
      checkedAt: "2026-06-08T12:00:00.000Z",
      environment: "production",
      publicBaseUrl: "https://siteflow.example.com",
      release: {
        commitRef: "abc123",
        repository: "acme/siteflow",
        branch: "main"
      },
      forwardedHeaders: expect.objectContaining({
        status: "todo",
        xForwardedForOverwritten: null,
        xForwardedHostOverwritten: null,
        xForwardedProtoOverwritten: null,
        proxyAddXForwardedForUsed: null
      }),
      proxySourcePolicy: expect.objectContaining({
        status: "todo",
        configured: "loopback",
        finalHopMatched: null,
        allSourcesTrusted: null
      }),
      deploymentTopology: expect.objectContaining({
        status: "todo",
        apiInstanceCount: null,
        apiProcessCount: null,
        ingressCount: null,
        multiInstance: null,
        multiProcess: null,
        multiIngress: null
      }),
      apiRateLimit: expect.objectContaining({
        status: "todo",
        edgeEnforced: null,
        sharedAcrossInstances: null,
        processLocalOnly: null,
        limiterScope: null,
        enforcementPoint: null
      }),
      operator: expect.objectContaining({
        status: "todo",
        name: "Platform Operator",
        ticketId: "CHG-123",
        ticketUrl: null
      }),
      operatorName: "Platform Operator",
      ticketId: "CHG-123"
    });
    expect(serialized).not.toMatch(/secret|authorization|token/i);
  });

  it("writes the template to disk and supports CLI JSON output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-operator-template-"));

    try {
      const outputPath = path.join(root, "operator-ingress.json");
      const written = await writeIngressOperatorEvidenceTemplate({
        ...baseOptions,
        outputPath
      });
      const fromDisk = JSON.parse(await readFile(outputPath, "utf8"));
      let stdout = "";
      let stderr = "";

      const exitCode = await runIngressOperatorEvidenceTemplateCli([
        "--commit-ref", "abc123",
        "--repo", "acme/siteflow",
        "--branch", "main",
        "--target-environment", "production",
        "--public-base-url", "https://siteflow.example.com",
        "--trust-proxy-policy", "loopback",
        "--operator-name", "Platform Operator",
        "--release-ticket", "CHG-123",
        "--checked-at", "2026-06-08T12:00:00.000Z",
        "--json"
      ], {
        stdout: { write: (chunk: string) => ((stdout += chunk), true) },
        stderr: { write: (chunk: string) => ((stderr += chunk), true) }
      });
      const printed = JSON.parse(stdout);

      expect(written).toMatchObject({ status: "blocked", dryRun: true, template: true });
      expect(fromDisk).toMatchObject({ status: "blocked", dryRun: true, template: true });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(printed).toMatchObject({
        checkedAt: "2026-06-08T12:00:00.000Z",
        proxySourcePolicy: {
          configured: "loopback"
        },
        operatorName: "Platform Operator",
        ticketId: "CHG-123"
      });
      expect(stdout).not.toMatch(/secret|authorization|token/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets ingressEvidenceCollect merge filled operator evidence for the sections the collector cannot probe", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "siteflow-ingress-operator-collect-"));

    try {
      const operatorEvidencePath = path.join(root, "operator-ingress.json");

      await writeFile(operatorEvidencePath, `${JSON.stringify(filledOperatorEvidence(), null, 2)}\n`, "utf8");

      const result = await collectIngressEvidence({
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
        operatorEvidencePath,
        fetchImpl: makeFetch(),
        now
      });

      expect(result).toMatchObject({
        status: "collected",
        exitCode: 0,
        checkResult: {
          status: "passed",
          exitCode: 0,
          selectedEvidence: {
            deploymentTopology: expect.objectContaining({
              apiInstanceCount: 2,
              apiProcessCount: 2,
              ingressCount: 1
            }),
            forwardedHeaders: expect.objectContaining({
              status: "passed"
            }),
            apiRateLimit: expect.objectContaining({
              edgeEnforced: true,
              sharedAcrossInstances: true,
              enforcementPoint: "ingress"
            })
          }
        }
      });
      expect(result.evidence).toMatchObject({
        forwardedHeaders: expect.objectContaining({
          xForwardedForOverwritten: true,
          proxyAddXForwardedForUsed: false
        }),
        proxySourcePolicy: expect.objectContaining({
          finalHopMatched: true,
          allSourcesTrusted: false
        })
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("documents why the raw operator-evidence template is not direct ingress:evidence checker input", () => {
    const template = createIngressOperatorEvidenceTemplate(baseOptions);
    const check = evaluateIngressEvidence(template, {
      evidencePath: "operator-ingress.json",
      commitRef: "abc123",
      repo: "acme/siteflow",
      branch: "main",
      targetEnvironment: "production",
      now
    });

    expect(check.status).toBe("blocked");
    expect(check.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "schema_version", status: "fail" }),
        expect.objectContaining({ name: "evidence_name", status: "fail" }),
        expect.objectContaining({ name: "direct_api_port_present", status: "fail" }),
        expect.objectContaining({ name: "unthrottled_routes_present", status: "fail" })
      ])
    );
  });

  it("parses arguments and rejects unsafe public URLs", async () => {
    expect(parseIngressOperatorEvidenceTemplateArgs([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "operator",
      "--ticket-id", "REL-1",
      "--public-base-url", "https://siteflow.example.com",
      "--trust-proxy-policy", "private",
      "--output", "operator-ingress.json",
      "--json"
    ])).toMatchObject({
      commitRef: "abc123",
      ticketId: "REL-1",
      publicBaseUrl: "https://siteflow.example.com",
      trustProxyPolicy: "private",
      json: true
    });

    let stderr = "";
    const exitCode = await runIngressOperatorEvidenceTemplateCli([
      "--commit-ref", "abc123",
      "--repo", "acme/siteflow",
      "--branch", "main",
      "--target-environment", "production",
      "--operator-name", "operator",
      "--release-ticket", "REL-1",
      "--public-base-url", "https://operator:unsafe@siteflow.example.com"
    ], {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => ((stderr += chunk), true) }
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("must not include credentials");
  });
});
