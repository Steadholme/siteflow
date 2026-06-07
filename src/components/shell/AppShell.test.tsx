import { render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { RoutePlaceholder } from "@app/RoutePlaceholder";
import { AppShell } from "@components/shell/AppShell";

function renderShell() {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <AppShell />,
        children: [{ path: "projects", element: <RoutePlaceholder page="projects" /> }]
      }
    ],
    { initialEntries: ["/projects"] }
  );

  return render(<RouterProvider router={router} />);
}

describe("AppShell", () => {
  it("renders the SiteFlow shell with primary navigation and project workspace", () => {
    renderShell();

    expect(screen.getByText("SiteFlow")).toBeInTheDocument();
    expect(screen.getByRole("main", { name: /siteflow workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: /primary navigation/i });

    for (const label of ["Projects", "Deployments", "Routes", "Artifacts", "Audit", "Settings"]) {
      expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
    }
  });
});
