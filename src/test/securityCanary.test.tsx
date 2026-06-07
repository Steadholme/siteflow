import { render, screen } from "@testing-library/react";
import { Navigate, RouterProvider, createMemoryRouter } from "react-router-dom";

import { AppShell } from "@components/shell/AppShell";
import { deploymentRoutes } from "@features/deployments/deploymentRoutes";
import { projectRoutes } from "@features/projects/projectRoutes";
import { releaseRoutes } from "@features/release/releaseRoutes";
import { SITEFLOW_SECRET_CANARY } from "@lib/redaction";

const routes = [
  { path: "/projects", heading: "Projects" },
  { path: "/projects/docs-portal", heading: "Acme Dashboard" },
  { path: "/deployments/dpl_4829", heading: "2026.05.15.101" },
  { path: "/projects/docs-portal/release/production", heading: "Promote deployment" },
  { path: "/projects/docs-portal/rollback/production", heading: "Rollback deployment" }
] as const;

const forbiddenFragments = [
  SITEFLOW_SECRET_CANARY,
  `Bearer ${SITEFLOW_SECRET_CANARY}`,
  `Loaded provider token ${SITEFLOW_SECRET_CANARY}`,
  `"deliverySecret":"${SITEFLOW_SECRET_CANARY}`,
  `"secretProbe":"${SITEFLOW_SECRET_CANARY}`,
  `"buildSecretEcho":"${SITEFLOW_SECRET_CANARY}`,
  `proxy_set_header Authorization Bearer ${SITEFLOW_SECRET_CANARY}`
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

describe("security canary rendering", () => {
  it.each(routes)("does not render fixture canaries on $path", async ({ path, heading }) => {
    renderConsoleRoute(path);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();

    const renderedText = document.body.textContent?.replace(/\s+/g, " ") ?? "";

    for (const fragment of forbiddenFragments) {
      expect(renderedText).not.toContain(fragment);
    }
    expect(renderedText).not.toMatch(/\bsf_(?:live|test)_[A-Za-z0-9_-]{8,}\b/);
    expect(renderedText).not.toMatch(/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/);
  });
});
