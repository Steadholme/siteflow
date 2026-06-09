import {
  releaseEvidencePackContractCheckUsage,
  runReleaseEvidencePackContractCheck,
  runReleaseEvidencePackContractCheckCli
} from "./releaseEvidencePackContractCheck";
import { createReleaseEvidenceRehearsalPack } from "./releaseEvidenceRehearsalPack";
import { validateReleaseEvidenceRehearsalPackContract } from "./releaseEvidenceRehearsalPackContract";

const now = () => new Date("2026-06-08T12:00:00.000Z");

function baseOptions(overrides: Partial<Parameters<typeof createReleaseEvidenceRehearsalPack>[0]> = {}) {
  return {
    commitRef: "abc123def4567890",
    repo: "acme/siteflow",
    branch: "main",
    targetEnvFile: "evidence/target.env",
    publicBaseUrl: "https://siteflow.example.com",
    operatorName: "release-operator",
    releaseTicket: "REL-2026-0608",
    observabilityTargetStackApiUrl: "https://observability.example.com/siteflow-proof",
    outputDir: "evidence/release-abc123def456",
    now,
    ...overrides
  };
}

function createIo() {
  const output = {
    stdout: "",
    stderr: ""
  };

  return {
    output,
    io: {
      stdout: {
        write: (message: string) => {
          output.stdout += message;
          return true;
        }
      },
      stderr: {
        write: (message: string) => {
          output.stderr += message;
          return true;
        }
      }
    }
  };
}

describe("releaseEvidencePackContractCheck", () => {
  it("passes a generated pack through contract validation and plan-only target-run checks", async () => {
    const result = await runReleaseEvidencePackContractCheck({ now });

    expect(result).toMatchObject({
      name: "siteflow-release-evidence-pack-contract-check",
      status: "passed",
      exitCode: 0,
      pack: {
        stepCount: 13,
        finalCommands: ["compose", "check"],
        commandPlaceholders: [
          "SITEFLOW_TRUST_PROXY",
          "api-instance-count",
          "api-process-count",
          "api-rate-limit-enforcement-point",
          "api-rate-limit-scope",
          "break-glass-approver-count",
          "break-glass-source",
          "candidate-deployment-detail-path",
          "deploy-key-path",
          "direct-api-url",
          "ingress-count",
          "known-hosts-path",
          "new-metrics-token-redacted-id",
          "new-root-api-token-redacted-id",
          "old-metrics-token-redacted-id",
          "old-root-api-token-redacted-id",
          "operator-access-denied-project-id",
          "operator-access-project-id",
          "release-image-digest",
          "release-image-run-id",
          "webhook-delivery-id"
        ],
        envPlaceholders: [
          "target-image@sha256:...",
          "target-or-disposable-postgres-url"
        ]
      },
      planOnly: {
        status: "planned",
        stepCount: 15,
        blockedSteps: []
      }
    });
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("release-evidence-contract-signing-key");
  });

  it("rejects generated packs whose final commands do not declare the attestation signing env", () => {
    const pack = createReleaseEvidenceRehearsalPack(baseOptions());

    pack.finalCommands.compose = {
      ...pack.finalCommands.compose,
      args: pack.finalCommands.compose.args.filter((arg) => arg !== "--attestation-key-env" && arg !== "SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY"),
      env: []
    };

    expect(() => validateReleaseEvidenceRehearsalPackContract(pack as unknown as Record<string, unknown>))
      .toThrow(/finalCommands\.compose command --attestation-key-env must be SITEFLOW_RELEASE_EVIDENCE_SIGNING_KEY/);
  });

  it("rejects generated packs whose final commands do not declare the optional attestation key id flag", () => {
    const pack = createReleaseEvidenceRehearsalPack(baseOptions());

    pack.finalCommands.check = {
      ...pack.finalCommands.check,
      args: pack.finalCommands.check.args.filter((arg) => arg !== "--attestation-key-id-env" && arg !== "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID"),
      env: pack.finalCommands.check.env?.filter((arg) => arg !== "SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID")
    };

    expect(() => validateReleaseEvidenceRehearsalPackContract(pack as unknown as Record<string, unknown>))
      .toThrow(/finalCommands\.check command --attestation-key-id-env must be SITEFLOW_RELEASE_EVIDENCE_REQUIRED_SIGNING_KEY_ID/);
  });

  it("prints JSON from the CLI entrypoint", async () => {
    const { io, output } = createIo();
    const code = await runReleaseEvidencePackContractCheckCli(["--json"], io);
    const result = JSON.parse(output.stdout) as ReturnType<typeof JSON.parse>;

    expect(code).toBe(0);
    expect(output.stderr).toBe("");
    expect(result).toMatchObject({
      name: "siteflow-release-evidence-pack-contract-check",
      status: "passed",
      exitCode: 0
    });
  });

  it("rejects unknown CLI options without running the check", async () => {
    const { io, output } = createIo();
    const code = await runReleaseEvidencePackContractCheckCli(["--wat"], io);

    expect(code).toBe(2);
    expect(output.stderr).toContain("Unknown option");
    expect(output.stderr).toContain(releaseEvidencePackContractCheckUsage());
  });
});
