import type { AnalyticsEventKind, SiteFlowId, WebVitalName } from "../domain/siteflow.js";
import { redactString } from "./redaction.js";

export interface AnalyticsEventInput {
  projectId: SiteFlowId;
  kind: string;
  path: string;
  referrer?: string;
  country?: string;
  browser?: string;
  device?: string;
  eventName?: string;
  vitalName?: string;
  vitalValue?: number;
  occurredAt?: string;
}

export interface NormalizedAnalyticsEventInput {
  projectId: SiteFlowId;
  kind: AnalyticsEventKind;
  path: string;
  referrer?: string;
  country?: string;
  browser?: string;
  device?: string;
  eventName?: string;
  vitalName?: WebVitalName;
  vitalValue?: number;
  occurredAt: string;
}

const analyticsKinds = new Set<AnalyticsEventKind>(["pageview", "custom", "web_vital"]);
const webVitalNames = new Set<WebVitalName>(["CLS", "FCP", "FID", "INP", "LCP", "TTFB"]);

function trimDimension(value: unknown, maxLength = 80) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = redactString(value.trim());
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function sanitizePath(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Analytics event path is required.");
  }

  const url = new URL(value.trim(), "https://siteflow.local");
  const pathname = url.pathname || "/";
  return redactString(pathname.startsWith("/") ? pathname : `/${pathname}`).slice(0, 512);
}

function sanitizeReferrer(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const url = new URL(value.trim(), "https://siteflow.local");
  const referrer = url.origin === "https://siteflow.local" ? url.pathname : `${url.origin}${url.pathname}`;
  const redacted = redactString(referrer || "/").slice(0, 512);
  return redacted || undefined;
}

function normalizeOccurredAt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return new Date().toISOString();
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error("Analytics event occurredAt must be an ISO timestamp.");
  }

  return date.toISOString();
}

export function normalizeAnalyticsEventInput(input: AnalyticsEventInput): NormalizedAnalyticsEventInput {
  if (!input.projectId?.trim()) {
    throw new Error("Analytics event project id is required.");
  }

  if (!analyticsKinds.has(input.kind as AnalyticsEventKind)) {
    throw new Error(`Invalid analytics event kind: ${input.kind}`);
  }

  const kind = input.kind as AnalyticsEventKind;
  const eventName = trimDimension(input.eventName, 120);
  const vitalName = trimDimension(input.vitalName, 16);
  const vitalValue = typeof input.vitalValue === "number" ? input.vitalValue : Number(input.vitalValue);

  if (kind === "custom" && !eventName) {
    throw new Error("Custom analytics events require eventName.");
  }

  if (kind === "web_vital") {
    if (!webVitalNames.has(vitalName as WebVitalName)) {
      throw new Error("Web vital analytics events require a valid vitalName.");
    }

    if (!Number.isFinite(vitalValue) || vitalValue < 0) {
      throw new Error("Web vital analytics events require a non-negative vitalValue.");
    }
  }

  return {
    projectId: input.projectId,
    kind,
    path: sanitizePath(input.path),
    referrer: sanitizeReferrer(input.referrer),
    country: trimDimension(input.country, 64),
    browser: trimDimension(input.browser, 64),
    device: trimDimension(input.device, 64),
    eventName: kind === "custom" ? eventName : undefined,
    vitalName: kind === "web_vital" ? vitalName as WebVitalName : undefined,
    vitalValue: kind === "web_vital" ? vitalValue : undefined,
    occurredAt: normalizeOccurredAt(input.occurredAt)
  };
}

export function analyticsWebVitalRating(name: WebVitalName, p75: number) {
  const thresholds: Record<WebVitalName, [number, number]> = {
    CLS: [0.1, 0.25],
    FCP: [1800, 3000],
    FID: [100, 300],
    INP: [200, 500],
    LCP: [2500, 4000],
    TTFB: [800, 1800]
  };
  const [good, poor] = thresholds[name];

  if (p75 <= good) {
    return "good" as const;
  }

  if (p75 <= poor) {
    return "needs_improvement" as const;
  }

  return "poor" as const;
}
