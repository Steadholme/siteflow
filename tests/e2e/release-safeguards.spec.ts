import { expect, test } from "@playwright/test";

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

test.describe("release safeguards", () => {
  test("keeps promotion disabled until safety checks, audit reason, and release evidence pass", async ({ page }) => {
    await page.goto("/projects/docs-portal/release/production");

    await expect(page.getByRole("heading", { name: "Safety checks" })).toBeVisible();
    await expect(page.getByText("Audit reason must be non-empty.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Release evidence" })).toBeVisible();

    const promote = page.getByRole("button", {
      name: /promote production from dep-acme-20260514-088 to dep-healthy and queue route apply/i
    });
    await expect(promote).toBeDisabled();

    await page.getByLabel("Promotion reason").fill("Ship the verified production candidate.");
    await expect(page.getByText("Production promotion requires a release evidence path.")).toBeVisible();
    await expect(promote).toBeDisabled();

    await page.getByLabel("Release evidence path").fill("evidence/release-evidence.json");
    await page.getByLabel("Release evidence bundle JSON").fill(JSON.stringify(releaseEvidenceBundle));
    await expect(
      page.getByRole("alert").filter({ hasText: "Release evidence requires a passing release:evidence checker result." })
    ).toBeVisible();
    await expect(promote).toBeDisabled();

    await page.getByLabel("Release evidence bundle JSON").fill(JSON.stringify({
      bundle: releaseEvidenceBundle,
      check: {
        ...releaseEvidenceCheck,
        selectedEvidence: undefined
      }
    }));
    await expect(
      page.getByRole("alert").filter({ hasText: "Release evidence checker result must include selected evidence summary." })
    ).toBeVisible();
    await expect(promote).toBeDisabled();

    await page.getByLabel("Release evidence bundle JSON").fill(JSON.stringify({
      bundle: releaseEvidenceBundle,
      check: releaseEvidenceCheck
    }));

    await expect(page.getByText("All required checks and audit fields are ready.")).toBeVisible();
    await expect(promote).toBeEnabled();
  });

  test("keeps rollback disabled until protected target, audit reason, and release evidence pass", async ({ page }) => {
    await page.goto("/projects/docs-portal/rollback/production");

    await expect(page.getByRole("heading", { name: "Known-good deployments" })).toBeVisible();
    await expect(page.getByText("Audit reason must be non-empty.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Release evidence" })).toBeVisible();

    const rollback = page.getByRole("button", {
      name: /rollback production from dep-healthy to dep-acme-20260514-088 without rebuild and queue route apply/i
    });
    await expect(rollback).toBeDisabled();

    await page.getByRole("textbox", { name: "Rollback reason" }).fill("Restore the last protected production deployment.");
    await expect(page.getByText("Production rollback requires a release evidence path.")).toBeVisible();
    await expect(rollback).toBeDisabled();

    await page.getByLabel("Release evidence path").fill("evidence/release-evidence.json");
    await page.getByLabel("Release evidence bundle JSON").fill(JSON.stringify({
      bundle: releaseEvidenceBundle,
      check: releaseEvidenceCheck
    }));

    await expect(page.getByText("All required checks and audit fields are ready.")).toBeVisible();
    await expect(rollback).toBeEnabled();
  });
});
