import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Navigate, RouterProvider, createMemoryRouter } from "react-router-dom";

import { AppShell } from "@components/shell/AppShell";
import { deploymentRoutes } from "@features/deployments/deploymentRoutes";
import { ProjectListPage } from "@features/projects/ProjectListPage";
import { projectRoutes } from "@features/projects/projectRoutes";
import { ReleaseConsolePage } from "@features/release/ReleaseConsolePage";
import { RollbackConsolePage } from "@features/release/RollbackConsolePage";
import { releaseRoutes } from "@features/release/releaseRoutes";
import type { ProjectListReadModel } from "@domain/readModels";
import { FixtureSiteFlowClient } from "@lib/api/fixtureClient";
import type { SiteFlowClient } from "@lib/api/siteflowClient";
import { fixtureProjectId } from "@lib/fixtures/siteflow.fixtures";
import {
  expectFocusableControlsHaveNames,
  expectHeadingStructure,
  expectIconButtonsHaveNames,
  expectPrimaryHeading,
  expectStatusPillsHaveText
} from "./accessibility";

const routeCases = [
  { path: "/projects", heading: "Projects", visibleText: "Project inventory" },
  { path: "/projects/docs-portal", heading: "Acme Dashboard", visibleText: "Deployment history" },
  { path: "/deployments/dpl_4829", heading: "2026.05.15.101", visibleText: "Deployment lineage" },
  { path: "/projects/docs-portal/release/production", heading: "Promote deployment", visibleText: "Audit reason" },
  { path: "/projects/docs-portal/rollback/production", heading: "Rollback deployment", visibleText: "Rollback reason" }
] as const;

function renderConsoleRoute(initialEntry: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <AppShell />,
        children: [
          { index: true, element: <Navigate to="/projects" replace /> },
          ...projectRoutes,
          ...deploymentRoutes,
          ...releaseRoutes,
          { path: "*", element: <Navigate to="/projects" replace /> }
        ]
      }
    ],
    { initialEntries: [initialEntry] }
  );

  return render(<RouterProvider router={router} />);
}

function clientWith(overrides: Partial<SiteFlowClient>): SiteFlowClient {
  const unexpected = async () => {
    throw new Error("Unexpected SiteFlow client call in console smoke test.");
  };

  return {
    listProjects: unexpected,
    listDeployments: unexpected,
    getProject: unexpected,
    getDeployment: unexpected,
    getReleaseConsole: unexpected,
    getRollbackConsole: unexpected,
    promoteDeployment: unexpected,
    rollbackDeployment: unexpected,
    pollOperation: unexpected,
    getLogChunk: unexpected,
    ...overrides
  } as SiteFlowClient;
}

function renderWithRouter(element: ReactElement) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

describe("operator console smoke", () => {
  it.each(routeCases)("renders $path", async ({ path, heading, visibleText }) => {
    renderConsoleRoute(path);

    await expectPrimaryHeading(heading);
    expect(await screen.findAllByText(visibleText)).not.toHaveLength(0);
    expectHeadingStructure();
    expectStatusPillsHaveText();
    expectIconButtonsHaveNames();
    expectFocusableControlsHaveNames();
    expect(document.body).not.toHaveTextContent("Project unavailable");
    expect(document.body).not.toHaveTextContent("API error");
  });
});

describe("operator state smoke", () => {
  it("renders a loading state before client data resolves", () => {
    renderWithRouter(
      <ProjectListPage
        client={clientWith({
          listProjects: () => new Promise<ProjectListReadModel>(() => undefined)
        })}
      />
    );

    expect(screen.getByText("Loading project inventory…")).toBeInTheDocument();
  });

  it("renders error and empty project states", async () => {
    const error = renderWithRouter(
      <ProjectListPage
        client={clientWith({
          listProjects: async () => {
            throw new Error("Projects API unavailable");
          }
        })}
      />
    );
    expect(await screen.findByText("Project inventory unavailable")).toBeInTheDocument();
    error.unmount();

    renderWithRouter(<ProjectListPage client={new FixtureSiteFlowClient("emptyProjects")} />);
    expect(await screen.findByText(/No SiteFlow projects have been created yet/i)).toBeInTheDocument();
  });

  it("renders route drift, stale candidate, and partial route failure states", async () => {
    const drift = renderWithRouter(<ProjectListPage client={new FixtureSiteFlowClient("routeDrift")} />);
    expect(await screen.findAllByText("Route drift")).not.toHaveLength(0);
    drift.unmount();

    const stale = renderWithRouter(
      <ReleaseConsolePage
        client={new FixtureSiteFlowClient("staleCandidate")}
        projectId={fixtureProjectId}
        channel="production"
        initialReason="Review stale candidate."
      />
    );
    expect(await screen.findByText("Stale candidate detected")).toBeInTheDocument();
    stale.unmount();

    renderWithRouter(
      <ReleaseConsolePage
        client={new FixtureSiteFlowClient("routeFailed")}
        projectId={fixtureProjectId}
        channel="production"
        initialReason="Promote after route repair."
      />
    );
    expect(await screen.findByText("Route apply failed")).toBeInTheDocument();
  });

  it("keeps rollback safety failures visible", async () => {
    renderWithRouter(
      <RollbackConsolePage
        client={new FixtureSiteFlowClient("rollbackIneligible")}
        projectId={fixtureProjectId}
        channel="production"
        initialReason="Rollback after incident review."
      />
    );

    expect(await screen.findByText("Rollback target ineligible")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /rollback production/i })).toBeDisabled();
  });
});
