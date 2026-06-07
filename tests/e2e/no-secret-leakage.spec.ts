import { expect, type Page, test } from "@playwright/test";

const routes = [
  "/projects",
  "/projects/docs-portal",
  "/deployments/dpl_4829",
  "/projects/docs-portal/release/production",
  "/projects/docs-portal/rollback/production"
] as const;

const forbiddenFragments = [
  "SITEFLOW_SECRET_CANARY_20260515",
  "Bearer SITEFLOW_SECRET_CANARY",
  "Loaded provider token SITEFLOW_SECRET_CANARY",
  "\"deliverySecret\":\"SITEFLOW_SECRET_CANARY",
  "\"secretProbe\":\"SITEFLOW_SECRET_CANARY",
  "\"buildSecretEcho\":\"SITEFLOW_SECRET_CANARY",
  "proxy_set_header Authorization Bearer SITEFLOW_SECRET_CANARY"
] as const;

const forbiddenPatterns = [
  /\bsf_(?:live|test)_[A-Za-z0-9_-]{8,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/,
  /\bBearer\s+SITEFLOW_SECRET_CANARY_[A-Z0-9_-]+\b/i
] as const;

async function renderedText(page: Page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
}

test.describe("no secret leakage", () => {
  for (const route of routes) {
    test(`does not render secret canaries on ${route}`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole("main", { name: "SiteFlow workspace" })).toBeVisible();

      const text = await renderedText(page);

      for (const fragment of forbiddenFragments) {
        expect(text, `${route} leaked ${fragment}`).not.toContain(fragment);
      }

      for (const pattern of forbiddenPatterns) {
        expect(text, `${route} leaked ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});
