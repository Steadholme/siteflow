import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { REDACTION_PLACEHOLDER, SITEFLOW_SECRET_CANARY } from "@lib/redaction";
import { createFixtureSiteFlowClient } from "@lib/api/fixtureClient";
import { SiteFlowHttpError } from "@lib/api/httpClient";
import type { SiteFlowClient } from "@lib/api/siteflowClient";
import type { SiteFlowScenarioName } from "@lib/fixtures/scenarios";
import { deploymentRoutes } from "./deploymentRoutes";
import { DeploymentDetailPage, DeploymentDetailWorkspace } from "./DeploymentDetailPage";
import { EvidenceTable } from "./components/EvidenceTable";
import { LogPanel } from "./components/LogPanel";

async function loadDeployment(scenario: SiteFlowScenarioName) {
  const client = createFixtureSiteFlowClient({ scenario });

  return client.getDeployment(`dep-${scenario}`);
}

function renderDeploymentRoute(path = "/deployments/dep-healthy") {
  const route = deploymentRoutes[0];

  if (!route.path || !route.element) {
    throw new Error("Deployment route must define a path and route element.");
  }

  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route.path} element={route.element} />
      </Routes>
    </MemoryRouter>
  );
}

function renderDeploymentPage(client: SiteFlowClient, path = "/deployments/dep-access-test") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/deployments/:deploymentId" element={<DeploymentDetailPage client={client} />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("deployment detail feature", () => {
  it("exports a deployment route that renders the evidence workspace instead of the placeholder", async () => {
    renderDeploymentRoute();

    expect(await screen.findByRole("heading", { name: "Deployment lineage" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Evidence table" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Build log" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Artifact proof" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Route revision" })).toBeInTheDocument();
  });

  it("renders the full source event to route revision lineage", async () => {
    const detail = await loadDeployment("healthy");

    render(<DeploymentDetailWorkspace detail={detail} />);

    const region = screen.getByRole("region", { name: "Scrollable deployment lineage" });
    const lineage = within(region).getByRole("list", { name: "Deployment lineage" });

    expect(region).toHaveAttribute("tabindex", "0");

    for (const label of ["Source event", "Build job", "Artifact", "Deployment", "Route revision"]) {
      expect(within(lineage).getByText(label)).toBeInTheDocument();
    }

    for (const station of ["Station 1", "Station 2", "Station 3", "Station 4", "Station 5"]) {
      expect(within(lineage).getByText(station)).toBeInTheDocument();
    }

    expect(screen.queryByRole("button", { name: /copy url/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /export evidence/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /download/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open manifest/i })).not.toBeInTheDocument();
  });

  it("keeps deployment success separate from route pending state", async () => {
    const detail = await loadDeployment("routePending");

    render(<DeploymentDetailWorkspace detail={detail} />);

    expect(screen.getAllByText("Deployment ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Route pending apply").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Routed$/i)).not.toBeInTheDocument();
  });

  it("redacts secret-like log canaries while preserving build step timestamps", async () => {
    const detail = await loadDeployment("healthy");
    const rawLogs = {
      ...detail.logs,
      chunk: {
        ...detail.logs.chunk,
        lines: [
          "01:20:01 Installing dependencies with npm ci",
          `01:21:44 Loaded provider token ${SITEFLOW_SECRET_CANARY}`,
          "01:23:20 Static output prepared for artifact publishing"
        ]
      }
    };

    render(<LogPanel logs={rawLogs} />);

    const log = screen.getByLabelText("Build log output");

    expect(log).toHaveTextContent("01:21:44 Loaded provider token");
    expect(log).toHaveTextContent(REDACTION_PLACEHOLDER);
    expect(log).not.toHaveTextContent(SITEFLOW_SECRET_CANARY);
  });

  it("distinguishes pass, failed, skipped, and stale evidence checks", async () => {
    const healthy = await loadDeployment("healthy");
    const routeFailed = await loadDeployment("routeFailed");
    const cdnDisabled = await loadDeployment("cdnDisabled");
    const routeDrift = await loadDeployment("routeDrift");
    const { rerender } = render(<EvidenceTable detail={healthy} />);

    expect(within(screen.getByRole("table", { name: "Evidence table" })).getAllByText("pass").length).toBeGreaterThan(0);

    rerender(<EvidenceTable detail={routeFailed} />);
    expect(within(screen.getByRole("table", { name: "Evidence table" })).getAllByText("failed").length).toBeGreaterThan(0);

    rerender(<EvidenceTable detail={cdnDisabled} />);
    expect(within(screen.getByRole("table", { name: "Evidence table" })).getByText("skipped")).toBeInTheDocument();

    rerender(<EvidenceTable detail={routeDrift} />);
    expect(within(screen.getByRole("table", { name: "Evidence table" })).getByText("stale")).toBeInTheDocument();
  });

  it.each([
    [401, "Sign-in required (401)", /operator session is missing or expired/i],
    [403, "Access denied (403)", /does not include the required permission/i]
  ])("renders a truthful %i deployment access error state", async (status, label, guidance) => {
    const client = createFixtureSiteFlowClient({ scenario: "healthy" });
    client.getDeployment = async () => {
      throw new SiteFlowHttpError(status, "/v1/deployments/dep-access-test", "Gateway rejected the deployment request.");
    };

    renderDeploymentPage(client);

    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByText(guidance)).toBeInTheDocument();
  });
});
