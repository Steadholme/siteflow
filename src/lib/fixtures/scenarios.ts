export const siteFlowScenarioNames = [
  "healthy",
  "queued",
  "routeDrift",
  "routePending",
  "routeFailed",
  "cdnDisabled",
  "rollbackIneligible",
  "staleCandidate",
  "emptyProjects"
] as const;

export type SiteFlowScenarioName = (typeof siteFlowScenarioNames)[number];

export function isSiteFlowScenarioName(value: string): value is SiteFlowScenarioName {
  return siteFlowScenarioNames.includes(value as SiteFlowScenarioName);
}
