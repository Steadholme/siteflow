import { isValidElement, type ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { FixtureSiteFlowClient } from "@lib/api/fixtureClient";
import { fixtureProjectId } from "@lib/fixtures/siteflow.fixtures";
import { ReleaseConsolePage } from "./ReleaseConsolePage";
import { RollbackConsolePage } from "./RollbackConsolePage";
import { releaseRoutes } from "./releaseRoutes";

function renderReleasePage(scenario: ConstructorParameters<typeof FixtureSiteFlowClient>[0], initialReason = "") {
  render(
    <MemoryRouter initialEntries={[`/projects/${fixtureProjectId}/release/production`]}>
      <Routes>
        <Route
          path="/projects/:projectId/release/:channel"
          element={<ReleaseConsolePage client={new FixtureSiteFlowClient(scenario)} initialReason={initialReason} />}
        />
      </Routes>
    </MemoryRouter>
  );
}

function renderRollbackPage(scenario: ConstructorParameters<typeof FixtureSiteFlowClient>[0], initialReason = "") {
  render(
    <MemoryRouter initialEntries={[`/projects/${fixtureProjectId}/rollback/production`]}>
      <Routes>
        <Route
          path="/projects/:projectId/rollback/:channel"
          element={<RollbackConsolePage client={new FixtureSiteFlowClient(scenario)} initialReason={initialReason} />}
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
  it("disables promotion until all safety checks pass and the audit reason has text", async () => {
    const user = userEvent.setup();

    renderReleasePage("healthy");

    expect(await screen.findByRole("heading", { name: "Candidate deployment" })).toBeVisible();
    expect(screen.getByText("Current production or current channel")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Safety checks" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Audit reason" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Route preview" })).toBeVisible();

    const promoteButton = screen.getByRole("button", {
      name: /promote production from dep-acme-20260514-088 to dep-healthy and queue route apply/i
    });
    expect(promoteButton).toBeDisabled();

    await user.type(screen.getByLabelText("Promotion reason"), "Ship verified dashboard build.");

    expect(promoteButton).toBeEnabled();
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

  it("submits rollback only after protected target checks and reason pass", async () => {
    const user = userEvent.setup();

    renderRollbackPage("healthy", "Restore last known-good dashboard.");

    const rollbackButton = await screen.findByRole("button", {
      name: /rollback production from dep-healthy to dep-acme-20260514-088 without rebuild and queue route apply/i
    });
    expect(rollbackButton).toBeEnabled();

    await user.click(rollbackButton);

    expect(await screen.findByText(/Rollback accepted and route operation queued/i)).toBeVisible();
  });
});
