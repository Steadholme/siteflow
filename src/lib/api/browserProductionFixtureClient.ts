import type { SiteFlowClient } from "./siteflowClient";

type FixtureSiteFlowClientOptions = string | { scenario?: string };

const productionFixtureError = "Fixture SiteFlow client is not available in production browser builds.";

export class FixtureSiteFlowClient {
  constructor(_options: FixtureSiteFlowClientOptions = {}) {
    throw new Error(productionFixtureError);
  }
}

export function createFixtureSiteFlowClient(_options?: FixtureSiteFlowClientOptions): SiteFlowClient {
  throw new Error(productionFixtureError);
}
