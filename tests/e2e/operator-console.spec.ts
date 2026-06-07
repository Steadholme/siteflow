import { expect, test } from "@playwright/test";

const operatorRoutes = [
  {
    path: "/projects",
    heading: "Projects",
    content: ["Project inventory", "Stale data guard"]
  },
  {
    path: "/projects/docs-portal",
    heading: "Acme Dashboard",
    content: ["Deployment history", "Secret policy"]
  },
  {
    path: "/deployments/dpl_4829",
    heading: "Deployment lineage",
    content: ["Evidence table", "Build log"]
  },
  {
    path: "/projects/docs-portal/release/production",
    heading: "Promote deployment",
    content: ["Candidate deployment", "Audit reason"]
  },
  {
    path: "/projects/docs-portal/rollback/production",
    heading: "Rollback deployment",
    content: ["Known-good deployments", "Rollback reason"]
  }
] as const;

test.describe("operator console routes", () => {
  for (const route of operatorRoutes) {
    test(`renders ${route.path}`, async ({ page }) => {
      await page.goto(route.path);

      await expect(page.getByRole("main", { name: "SiteFlow workspace" })).toBeVisible();
      await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();

      for (const text of route.content) {
        await expect(page.getByText(text).first()).toBeVisible();
      }

      await expect(page.getByText("Project unavailable")).toHaveCount(0);
      await expect(page.getByText("API error")).toHaveCount(0);
    });
  }
});
