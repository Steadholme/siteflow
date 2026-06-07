import { render, screen } from "@testing-library/react";
import { createMemoryRouter, MemoryRouter, Outlet, RouterProvider } from "react-router-dom";

import type { ProjectListReadModel } from "@domain/readModels";
import { FixtureSiteFlowClient } from "@lib/api/fixtureClient";
import type { SiteFlowClient } from "@lib/api/siteflowClient";
import { fixtureProjectId } from "@lib/fixtures/siteflow.fixtures";
import { SITEFLOW_SECRET_CANARY } from "@lib/redaction";
import { ProjectDetailPage } from "./ProjectDetailPage";
import { ProjectListPage } from "./ProjectListPage";
import { projectRoutes } from "./projectRoutes";

function renderProjectRoutes(initialEntry: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <Outlet />,
        children: projectRoutes
      }
    ],
    { initialEntries: [initialEntry] }
  );

  return render(<RouterProvider router={router} />);
}

function renderListPage(client: SiteFlowClient) {
  return render(
    <MemoryRouter>
      <ProjectListPage client={client} />
    </MemoryRouter>
  );
}

function renderDetailPage(client: SiteFlowClient, projectId = fixtureProjectId) {
  const router = createMemoryRouter(
    [
      {
        path: "/projects/:projectId",
        element: <ProjectDetailPage client={client} />
      }
    ],
    { initialEntries: [`/projects/${projectId}`] }
  );

  return render(<RouterProvider router={router} />);
}

function clientWith(overrides: Partial<SiteFlowClient>): SiteFlowClient {
  const unexpected = async () => {
    throw new Error("Unexpected SiteFlow client call in project test.");
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

async function pausedProjectList(): Promise<ProjectListReadModel> {
  const data = await new FixtureSiteFlowClient("healthy").listProjects();

  return {
    ...data,
    summary: {
      ...data.summary,
      activeProjects: 0
    },
    projects: data.projects.map((item) => ({
      ...item,
      project: {
        ...item.project,
        status: "paused" as const
      }
    }))
  };
}

describe("projectRoutes", () => {
  it("renders project inventory metrics and fixture projects", async () => {
    renderProjectRoutes("/projects");

    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(screen.getByText("Project inventory")).toBeInTheDocument();
    expect(screen.getByText("Active projects")).toBeInTheDocument();
    expect(screen.getByText("Routing revisions")).toBeInTheDocument();
    expect(screen.getByText("Protected artifacts")).toBeInTheDocument();
    expect(screen.getAllByText("Acme Dashboard").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Healthy").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Routed").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Verified").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Protected").length).toBeGreaterThan(0);
  });

  it("renders project detail deployment, environment, settings, and activity views", async () => {
    renderProjectRoutes(`/projects/${fixtureProjectId}`);

    expect(await screen.findByRole("heading", { level: 1, name: "Acme Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Deployment history")).toBeInTheDocument();
    expect(screen.getAllByText("Repository").length).toBeGreaterThan(0);
    expect(screen.getByText("Domains")).toBeInTheDocument();
    expect(screen.getAllByText("Production").length).toBeGreaterThan(0);
    expect(screen.getByText("Staging")).toBeInTheDocument();
    expect(screen.getByText("Previews")).toBeInTheDocument();
    expect(screen.getByText("Web Analytics")).toBeInTheDocument();
    expect(screen.getByText("Speed Insights")).toBeInTheDocument();
    expect(screen.getByText("Top pages")).toBeInTheDocument();
    expect(screen.getByText("Pageviews")).toBeInTheDocument();
    expect(screen.getByText("/pricing")).toBeInTheDocument();
    expect(screen.getByText("LCP")).toBeInTheDocument();
    expect(screen.getByText("Recent events")).toBeInTheDocument();
    expect(screen.getByText(/Secret values and provider payloads are redacted/i)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(SITEFLOW_SECRET_CANARY);
  });
});

describe("ProjectListPage states", () => {
  it("renders the no-project state", async () => {
    renderListPage(new FixtureSiteFlowClient("emptyProjects"));

    expect(await screen.findByText(/No SiteFlow projects have been created yet/i)).toBeInTheDocument();
  });

  it("renders paused project state from fixture-shaped data", async () => {
    const data = await pausedProjectList();
    renderListPage(clientWith({ listProjects: async () => data }));

    expect((await screen.findAllByText("Paused")).length).toBeGreaterThan(0);
  });

  it("renders queued-build and route-drift states", async () => {
    const queued = renderListPage(new FixtureSiteFlowClient("queued"));
    expect((await screen.findAllByText("Build queued")).length).toBeGreaterThan(0);
    queued.unmount();

    renderListPage(new FixtureSiteFlowClient("routeDrift"));
    expect((await screen.findAllByText("Route drift")).length).toBeGreaterThan(0);
  });

  it("renders API error state", async () => {
    renderListPage(
      clientWith({
        listProjects: async () => {
          throw new Error("Projects API unavailable");
        }
      })
    );

    expect(await screen.findByText("Project inventory unavailable")).toBeInTheDocument();
    expect(screen.getByText("Projects API unavailable")).toBeInTheDocument();
  });
});

describe("ProjectDetailPage safeguards", () => {
  it("does not render fixture secret canaries", async () => {
    renderDetailPage(new FixtureSiteFlowClient("healthy"));

    expect(await screen.findByText("Secret policy")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(SITEFLOW_SECRET_CANARY);
  });

  it("renders project detail API error state", async () => {
    renderDetailPage(
      clientWith({
        getProject: async () => {
          throw new Error("Project detail API unavailable");
        }
      })
    );

    expect(await screen.findByText("Project unavailable")).toBeInTheDocument();
    expect(screen.getByText("Project detail API unavailable")).toBeInTheDocument();
  });
});
