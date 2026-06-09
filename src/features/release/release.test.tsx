import { isValidElement, type ReactElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { PromoteDeploymentCommand, RollbackDeploymentCommand, SiteFlowClient } from "@lib/api";
import { FixtureSiteFlowClient } from "@lib/api/fixtureClient";
import { fixtureProjectId } from "@lib/fixtures/siteflow.fixtures";
import { REDACTION_PLACEHOLDER, SITEFLOW_SECRET_CANARY } from "@lib/redaction";
import { ReleaseConsolePage } from "./ReleaseConsolePage";
import { RollbackConsolePage } from "./RollbackConsolePage";
import { releaseRoutes } from "./releaseRoutes";

const releaseEvidenceIdentity = {
  commitRef: "abc123def456",
  repository: "acme/siteflow",
  branch: "main",
  targetEnvironment: "production",
  channel: "production",
  deploymentId: "dep-healthy"
};
const releaseEvidenceBundle = {
  schemaVersion: "siteflow.releaseEvidence.v1",
  name: "siteflow-release-evidence-bundle",
  targetEnvironment: releaseEvidenceIdentity.targetEnvironment,
  channel: releaseEvidenceIdentity.channel,
  deploymentId: releaseEvidenceIdentity.deploymentId,
  release: releaseEvidenceIdentity
};
const releaseEvidenceCheck = {
  name: "siteflow-release-evidence-bundle-check",
  status: "passed",
  checkedAt: "2026-06-07T12:00:00.000Z",
  evidencePath: "evidence/release-evidence.json",
  exitCode: 0,
  selectedEvidence: {
    releaseCommitRef: releaseEvidenceIdentity.commitRef,
    repository: releaseEvidenceIdentity.repository,
    branch: releaseEvidenceIdentity.branch,
    targetEnvironment: releaseEvidenceIdentity.targetEnvironment,
    channel: releaseEvidenceIdentity.channel,
    deploymentId: releaseEvidenceIdentity.deploymentId,
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
  checks: [
    {
      name: "bundle_shape",
      status: "pass",
      message: "Bundle shape passed."
    }
  ]
};

function releaseEvidenceText({
  bundle = releaseEvidenceBundle,
  check = releaseEvidenceCheck
}: {
  bundle?: Record<string, unknown>;
  check?: Record<string, unknown>;
} = {}) {
  return JSON.stringify({ bundle, check });
}

const releaseEvidenceBundleText = releaseEvidenceText();

function releaseEvidenceCheckWithSelectedEvidence(selectedEvidence: Partial<typeof releaseEvidenceCheck.selectedEvidence>) {
  return {
    ...releaseEvidenceCheck,
    selectedEvidence: {
      ...releaseEvidenceCheck.selectedEvidence,
      ...selectedEvidence
    }
  };
}

class RecordingReleaseClient extends FixtureSiteFlowClient {
  promoteCommands: PromoteDeploymentCommand[] = [];
  rollbackCommands: RollbackDeploymentCommand[] = [];

  override async promoteDeployment(command: PromoteDeploymentCommand) {
    this.promoteCommands.push(command);
    return super.promoteDeployment(command);
  }

  override async rollbackDeployment(command: RollbackDeploymentCommand) {
    this.rollbackCommands.push(command);
    return super.rollbackDeployment(command);
  }
}

function fillReleaseEvidence() {
  fireEvent.change(screen.getByLabelText("Release evidence path"), {
    target: { value: "evidence/release-evidence.json" }
  });
  fireEvent.change(screen.getByLabelText("Release evidence bundle JSON"), {
    target: { value: releaseEvidenceBundleText }
  });
}

function renderReleasePage(scenario: ConstructorParameters<typeof FixtureSiteFlowClient>[0], initialReason = "", client?: SiteFlowClient) {
  render(
    <MemoryRouter initialEntries={[`/projects/${fixtureProjectId}/release/production`]}>
      <Routes>
        <Route
          path="/projects/:projectId/release/:channel"
          element={<ReleaseConsolePage client={client ?? new FixtureSiteFlowClient(scenario)} initialReason={initialReason} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

function renderRollbackPage(scenario: ConstructorParameters<typeof FixtureSiteFlowClient>[0], initialReason = "", client?: SiteFlowClient) {
  render(
    <MemoryRouter initialEntries={[`/projects/${fixtureProjectId}/rollback/production`]}>
      <Routes>
        <Route
          path="/projects/:projectId/rollback/:channel"
          element={<RollbackConsolePage client={client ?? new FixtureSiteFlowClient(scenario)} initialReason={initialReason} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

describe("release routes", () => {
  it("exports release and rollback route elements without placeholders", () => {
    expect(releaseRoutes.map((route) => route.path)).toEqual([
      "projects/:projectId/release/:channel",
      "projects/:projectId/rollback/:channel"
    ]);
    expect(isValidElement(releaseRoutes[0].element)).toBe(true);
    expect(isValidElement(releaseRoutes[1].element)).toBe(true);
    expect((releaseRoutes[0].element as ReactElement).type).toBe(ReleaseConsolePage);
    expect((releaseRoutes[1].element as ReactElement).type).toBe(RollbackConsolePage);
  });
});

describe("ReleaseConsolePage", () => {
  it("disables promotion until safety checks, audit reason, and release evidence pass", async () => {
    const user = userEvent.setup();

    renderReleasePage("healthy");

    expect(await screen.findByRole("heading", { name: "Candidate deployment" })).toBeVisible();
    expect(screen.getByText("Current production or current channel")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Safety checks" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Audit reason" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Release evidence" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Route preview" })).toBeVisible();

    const promoteButton = screen.getByRole("button", {
      name: /promote production from dep-acme-20260514-088 to dep-healthy and queue route apply/i
    });
    expect(promoteButton).toBeDisabled();

    await user.type(screen.getByLabelText("Promotion reason"), "Ship verified dashboard build.");

    expect(promoteButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Release evidence path"), {
      target: { value: "evidence/release-evidence.json" }
    });
    fireEvent.change(screen.getByLabelText("Release evidence bundle JSON"), {
      target: { value: "{bad json" }
    });

    expect(screen.getAllByText("Release evidence bundle JSON must be valid JSON.").length).toBeGreaterThan(0);
    expect(promoteButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Release evidence bundle JSON"), {
      target: {
        value: JSON.stringify({
          schemaVersion: "siteflow.releaseEvidence.v1",
          name: "siteflow-release-evidence-bundle",
          targetEnvironment: "staging"
        })
      }
    });

    expect(screen.getAllByText("Release evidence bundle targetEnvironment must be production.").length).toBeGreaterThan(0);
    expect(promoteButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Release evidence bundle JSON"), {
      target: { value: JSON.stringify(releaseEvidenceBundle) }
    });

    expect(screen.getAllByText("Release evidence requires a passing release:evidence checker result.").length).toBeGreaterThan(0);
    expect(promoteButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Release evidence bundle JSON"), {
      target: {
        value: JSON.stringify({
          bundle: releaseEvidenceBundle,
          check: {
            ...releaseEvidenceCheck,
            selectedEvidence: undefined
          }
        })
      }
    });

    expect(screen.getAllByText("Release evidence checker result must include selected evidence summary.").length).toBeGreaterThan(0);
    expect(promoteButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Release evidence bundle JSON"), {
      target: { value: releaseEvidenceBundleText }
    });

    expect(promoteButton).toBeEnabled();
  });

  it("submits production promotion with a release evidence bundle request", async () => {
    const user = userEvent.setup();
    const client = new RecordingReleaseClient("healthy");

    renderReleasePage("healthy", "Ship verified dashboard build.", client);

    const promoteButton = await screen.findByRole("button", {
      name: /promote production from dep-acme-20260514-088 to dep-healthy and queue route apply/i
    });
    fillReleaseEvidence();

    await user.click(promoteButton);

    expect(await screen.findByText(/Promotion accepted and route operation queued/i)).toBeVisible();
    expect(client.promoteCommands[0]).toMatchObject({
      releaseEvidence: {
        evidencePath: "evidence/release-evidence.json",
        bundle: releaseEvidenceBundle
      }
    });
  });

  it.each([
    ["release commit", releaseEvidenceCheckWithSelectedEvidence({ releaseCommitRef: "old-release-commit" }), "release commit"],
    ["repository", releaseEvidenceCheckWithSelectedEvidence({ repository: "acme/stale-dashboard" }), "repository"],
    ["branch", releaseEvidenceCheckWithSelectedEvidence({ branch: "release/old" }), "branch"],
    ["target environment", releaseEvidenceCheckWithSelectedEvidence({ targetEnvironment: "staging" }), "target environment"],
    ["channel", releaseEvidenceCheckWithSelectedEvidence({ channel: "staging" }), "channel"],
    ["deployment", releaseEvidenceCheckWithSelectedEvidence({ deploymentId: "dep-stale" }), "deployment"]
  ])("keeps production promotion disabled when checker selectedEvidence has mismatched %s", async (_label, check, mismatch) => {
    renderReleasePage("healthy", "Ship verified dashboard build.");

    const promoteButton = await screen.findByRole("button", {
      name: /promote production from dep-acme-20260514-088 to dep-healthy and queue route apply/i
    });

    fireEvent.change(screen.getByLabelText("Release evidence path"), {
      target: { value: "evidence/release-evidence.json" }
    });
    fireEvent.change(screen.getByLabelText("Release evidence bundle JSON"), {
      target: { value: releaseEvidenceText({ check }) }
    });

    expect(screen.getAllByText(`Release evidence checker selected evidence must match bundle ${mismatch}.`).length).toBeGreaterThan(0);
    expect(promoteButton).toBeDisabled();
  });

  it("keeps stale candidates disabled even with an audit reason", async () => {
    renderReleasePage("staleCandidate", "Promote after review.");

    expect(await screen.findByText("Stale candidate detected")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: /promote production from dep-acme-20260514-088 to dep-stalecandidate and queue route apply/i
      })
    ).toBeDisabled();
  });

  it("renders command boundaries with channel, deployments, actor, reason, and route consequence", async () => {
    renderReleasePage("healthy", "Release verified checkout telemetry.");

    expect(await screen.findByText(/production: dep-acme-20260514-088 -> dep-healthy/i)).toBeVisible();
    expect(screen.getByText(/Maya Chen \(release_manager\)/)).toBeVisible();
    expect(screen.getAllByText("Release verified checkout telemetry.").length).toBeGreaterThan(0);
    expect(screen.getByText(/Queue route revision route-healthy for production/i)).toBeVisible();
  });

  it("redacts generated route config secrets in the dry-run preview", async () => {
    renderReleasePage("healthy");

    const generatedConfig = await screen.findByLabelText("Generated route config preview");

    expect(generatedConfig.textContent).toContain(REDACTION_PLACEHOLDER);
    expect(generatedConfig.textContent).not.toContain(SITEFLOW_SECRET_CANARY);
  });

  it("shows route apply failure as a partial outcome and blocks promotion", async () => {
    renderReleasePage("routeFailed", "Promote after route repair.");

    expect(await screen.findByText("Route apply failed")).toBeVisible();
    expect(screen.getByText(/previous known-good route remains active/i)).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: /promote production from dep-acme-20260514-088 to dep-routefailed and queue route apply/i
      })
    ).toBeDisabled();
  });
});

describe("RollbackConsolePage", () => {
  it("disables rollback targets with failed or unverified artifact safeguards", async () => {
    renderRollbackPage("rollbackIneligible", "Rollback after incident review.");

    expect(await screen.findByRole("heading", { name: "Known-good deployments" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Rollback impact" })).toBeVisible();
    expect(screen.getAllByText("Artifact protection")[0]).toBeVisible();
    expect(screen.getByText("Rebuild required")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Rollback reason" })).toBeVisible();

    expect(screen.getByRole("radio", { name: /select rollback target dep-acme-20260514-088/i })).toBeDisabled();
    expect(screen.getByText("Rollback target ineligible")).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: /rollback production from dep-rollbackineligible to dep-acme-20260514-088 without rebuild and queue route apply/i
      })
    ).toBeDisabled();
  });

  it("submits rollback only after protected target checks, reason, and release evidence pass", async () => {
    const user = userEvent.setup();
    const client = new RecordingReleaseClient("healthy");

    renderRollbackPage("healthy", "Restore last known-good dashboard.", client);

    const rollbackButton = await screen.findByRole("button", {
      name: /rollback production from dep-healthy to dep-acme-20260514-088 without rebuild and queue route apply/i
    });
    expect(screen.getByRole("heading", { name: "Release evidence" })).toBeVisible();
    expect(rollbackButton).toBeDisabled();

    fillReleaseEvidence();

    expect(rollbackButton).toBeEnabled();

    await user.click(rollbackButton);

    expect(await screen.findByText(/Rollback accepted and route operation queued/i)).toBeVisible();
    expect(client.rollbackCommands[0]).toMatchObject({
      releaseEvidence: {
        evidencePath: "evidence/release-evidence.json",
        bundle: releaseEvidenceBundle
      }
    });
  });
});
