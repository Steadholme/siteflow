import { sealSecretValue, unsealSecretValue } from "./sealedSecrets";

describe("sealed secret helpers", () => {
  it("encrypts secret values into an envelope and decrypts them with the same key", () => {
    const sealed = sealSecretValue("sf_live_secret_value", "test-sealing-key");

    expect(sealed).toMatch(/^sfseal:v1:/);
    expect(sealed).not.toContain("sf_live_secret_value");
    expect(unsealSecretValue(sealed, "test-sealing-key")).toBe("sf_live_secret_value");
  });

  it("keeps legacy plaintext sealed values readable for existing installs", () => {
    expect(unsealSecretValue("legacy-secret-value", "test-sealing-key")).toBe("legacy-secret-value");
  });

  it("rejects envelopes encrypted with another sealing key", () => {
    const sealed = sealSecretValue("sf_live_secret_value", "first-key");

    expect(() => unsealSecretValue(sealed, "second-key")).toThrow(/decrypt/i);
  });
});
