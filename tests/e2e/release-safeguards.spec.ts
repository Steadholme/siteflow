import { expect, test } from "@playwright/test";

test.describe("release safeguards", () => {
  test("keeps promotion disabled until safety checks and audit reason pass", async ({ page }) => {
    await page.goto("/projects/docs-portal/release/production");

    await expect(page.getByRole("heading", { name: "Safety checks" })).toBeVisible();
    await expect(page.getByText("Audit reason must be non-empty.")).toBeVisible();

    const promote = page.getByRole("button", {
      name: /promote production from dep-acme-20260514-088 to dep-healthy and queue route apply/i
    });
    await expect(promote).toBeDisabled();

    await page.getByLabel("Promotion reason").fill("Ship the verified production candidate.");
    await expect(page.getByText("All required checks and audit fields are ready.")).toBeVisible();
    await expect(promote).toBeEnabled();
  });

  test("keeps rollback disabled until protected target and audit reason pass", async ({ page }) => {
    await page.goto("/projects/docs-portal/rollback/production");

    await expect(page.getByRole("heading", { name: "Known-good deployments" })).toBeVisible();
    await expect(page.getByText("Audit reason must be non-empty.")).toBeVisible();

    const rollback = page.getByRole("button", {
      name: /rollback production from dep-healthy to dep-acme-20260514-088 without rebuild and queue route apply/i
    });
    await expect(rollback).toBeDisabled();

    await page.getByRole("textbox", { name: "Rollback reason" }).fill("Restore the last protected production deployment.");
    await expect(page.getByText("All required checks and audit fields are ready.")).toBeVisible();
    await expect(rollback).toBeEnabled();
  });
});
