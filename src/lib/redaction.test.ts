import {
  REDACTION_PLACEHOLDER,
  SITEFLOW_SECRET_CANARY,
  redactLogLines,
  redactManifest,
  redactProviderPayload,
  redactRouteConfig,
  redactSecrets
} from "@lib/redaction";

describe("redaction", () => {
  it("removes secret canary values from nested project data", () => {
    const redacted = redactSecrets({
      settings: {
        apiToken: SITEFLOW_SECRET_CANARY,
        nested: {
          value: `prefix-${SITEFLOW_SECRET_CANARY}-suffix`
        }
      }
    });

    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(SITEFLOW_SECRET_CANARY);
    expect(serialized).toContain(REDACTION_PLACEHOLDER);
  });

  it("removes canaries from logs, manifests, route config, and provider payloads", () => {
    const redactedLog = redactLogLines([`build exported ${SITEFLOW_SECRET_CANARY}`]);
    const redactedManifest = redactManifest({
      env: {
        SITEFLOW_TOKEN: SITEFLOW_SECRET_CANARY
      }
    });
    const redactedRoute = redactRouteConfig(`proxy_set_header Authorization Bearer ${SITEFLOW_SECRET_CANARY};`);
    const redactedProviderPayload = redactProviderPayload({
      deliverySecret: SITEFLOW_SECRET_CANARY
    });

    const serialized = JSON.stringify({
      redactedLog,
      redactedManifest,
      redactedRoute,
      redactedProviderPayload
    });

    expect(serialized).not.toContain(SITEFLOW_SECRET_CANARY);
    expect(serialized).toContain(REDACTION_PLACEHOLDER);
  });
});
