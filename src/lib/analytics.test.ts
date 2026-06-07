import { SITEFLOW_SECRET_CANARY } from "./redaction";
import { analyticsWebVitalRating, normalizeAnalyticsEventInput } from "./analytics";

describe("analytics helpers", () => {
  it("normalizes analytics event URLs and redacts sensitive dimensions", () => {
    const event = normalizeAnalyticsEventInput({
      projectId: "project-acme-dashboard",
      kind: "pageview",
      path: `/pricing?token=${SITEFLOW_SECRET_CANARY}#plans`,
      referrer: `https://vercel.com/templates?token=${SITEFLOW_SECRET_CANARY}#card`,
      country: "US",
      browser: `Chrome ${SITEFLOW_SECRET_CANARY}`,
      device: "desktop",
      occurredAt: "2026-05-26T00:00:00.000Z"
    });
    const serialized = JSON.stringify(event);

    expect(event).toMatchObject({
      projectId: "project-acme-dashboard",
      kind: "pageview",
      path: "/pricing",
      referrer: "https://vercel.com/templates",
      country: "US",
      browser: expect.stringContaining("[REDACTED]"),
      device: "desktop",
      occurredAt: "2026-05-26T00:00:00.000Z"
    });
    expect(serialized).not.toContain("?token=");
    expect(serialized).not.toContain("#plans");
    expect(serialized).not.toContain(SITEFLOW_SECRET_CANARY);
  });

  it("rejects invalid web vital payloads", () => {
    expect(() =>
      normalizeAnalyticsEventInput({
        projectId: "project-acme-dashboard",
        kind: "web_vital",
        path: "/",
        vitalName: "TTI",
        vitalValue: 120
      })
    ).toThrow("Web vital analytics events require a valid vitalName.");

    expect(() =>
      normalizeAnalyticsEventInput({
        projectId: "project-acme-dashboard",
        kind: "web_vital",
        path: "/",
        vitalName: "LCP",
        vitalValue: -1
      })
    ).toThrow("Web vital analytics events require a non-negative vitalValue.");
  });

  it("rates Web Vitals against p75 thresholds", () => {
    expect(analyticsWebVitalRating("LCP", 2500)).toBe("good");
    expect(analyticsWebVitalRating("LCP", 3000)).toBe("needs_improvement");
    expect(analyticsWebVitalRating("LCP", 4500)).toBe("poor");
  });
});
