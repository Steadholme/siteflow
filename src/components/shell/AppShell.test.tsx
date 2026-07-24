import { render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { RoutePlaceholder } from "@app/RoutePlaceholder";
import { AppShell } from "@components/shell/AppShell";

function renderShell(initialEntry = "/projects") {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: <AppShell />,
        children: [
          { path: "projects", element: <RoutePlaceholder page="projects" /> },
          { path: "projects/:projectId", element: <RoutePlaceholder page="projects" /> },
          {
            path: "projects/:projectId/release/:channel",
            element: <RoutePlaceholder page="release" />
          },
          {
            path: "projects/:projectId/rollback/:channel",
            element: <RoutePlaceholder page="rollback" />
          }
        ]
      }
    ],
    { initialEntries: [initialEntry] }
  );

  return render(<RouterProvider router={router} />);
}

describe("AppShell", () => {
  it("renders only factual yard navigation without a project context", () => {
    renderShell();

    expect(screen.getByText("SiteFlow")).toBeInTheDocument();
    expect(screen.getByRole("main", { name: /siteflow workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Yard" });

    expect(within(nav).getByRole("link", { name: "Projects" })).toHaveAttribute("href", "/projects");
    expect(screen.queryByRole("navigation", { name: "This project" })).not.toBeInTheDocument();
    expect(screen.queryByText("All systems nominal")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new project/i })).not.toBeInTheDocument();
    expect(screen.getByText("Projects / Yard inventory")).toBeInTheDocument();
  });

  it("derives project links and console location from the current route", () => {
    renderShell("/projects/alpha-service/release/production");

    const nav = screen.getByRole("navigation", { name: "This project" });
    expect(within(nav).getByRole("link", { name: "Project board" })).toHaveAttribute(
      "href",
      "/projects/alpha-service"
    );
    expect(within(nav).getByRole("link", { name: "Promote to production" })).toHaveAttribute(
      "href",
      "/projects/alpha-service/release/production"
    );
    expect(within(nav).getByRole("link", { name: "Rollback production" })).toHaveAttribute(
      "href",
      "/projects/alpha-service/rollback/production"
    );
    expect(screen.getByText("Projects / alpha-service / Promotion gate / production")).toBeInTheDocument();
  });
});
