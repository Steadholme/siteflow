import { expect, type Locator, type Page, test } from "@playwright/test";

const routes = [
  { path: "/projects", keyContent: "Project inventory", action: "Refresh" },
  { path: "/projects/docs-portal", keyContent: "Deployment history", action: "Promote" },
  { path: "/deployments/dpl_4829", keyContent: "Build log", action: "Refresh" },
  { path: "/projects/docs-portal/release/production", keyContent: "Safety checks", action: /Promote production/i },
  { path: "/projects/docs-portal/rollback/production", keyContent: "Rollback impact", action: /Rollback production/i }
] as const;

async function expectNoViewportOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth
  }));
  const allowedSubpixelVariance = 1;

  expect(metrics.bodyScrollWidth, `body overflow at ${metrics.viewportWidth}px`).toBeLessThanOrEqual(
    metrics.viewportWidth + allowedSubpixelVariance
  );
  expect(metrics.documentScrollWidth, `document overflow at ${metrics.viewportWidth}px`).toBeLessThanOrEqual(
    metrics.viewportWidth + allowedSubpixelVariance
  );
}

async function expectActionWithinViewport(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();

  expect(box, "primary action should have a layout box").not.toBeNull();
  if (!box) {
    return;
  }

  const viewport = locator.page().viewportSize();
  expect(viewport, "viewport should be available").not.toBeNull();
  if (!viewport) {
    return;
  }

  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
}

async function primaryAction(page: Page, name: string | RegExp) {
  const button = page.getByRole("button", { name });

  if ((await button.count()) > 0) {
    return button.first();
  }

  return page.getByRole("link", { name }).first();
}

test.describe("responsive layout hardening", () => {
  for (const route of routes) {
    test(`keeps ${route.path} content visible without body overflow`, async ({ page }) => {
      await page.goto(route.path);

      await expect(page.getByText(route.keyContent).first()).toBeVisible();
      await expectNoViewportOverflow(page);

      const action = await primaryAction(page, route.action);
      await expect(action).toBeVisible();
      await expectActionWithinViewport(action);
    });
  }
});
