import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertProductionSecretStrength, requireProductionSecret, resolveSealingSecret, resolveSecretEnvValue, sealSecretValue, unsealSecretValue } from "./sealedSecrets";

describe("sealed secret helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it("prefers SITEFLOW_APP_SECRET over SITEFLOW_SEALING_KEY", () => {
    expect(
      resolveSealingSecret(undefined, {
        SITEFLOW_APP_SECRET: "app-secret",
        SITEFLOW_SEALING_KEY: "legacy-sealing-key"
      })
    ).toBe("app-secret");
  });

  it("resolves direct environment secrets before *_FILE fallbacks", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-secret-file-"));

    try {
      const secretPath = path.join(tempDir, "api-token");
      await writeFile(secretPath, "file-token\n", "utf8");

      expect(resolveSecretEnvValue("SITEFLOW_API_TOKEN", {
        SITEFLOW_API_TOKEN: " direct-token ",
        SITEFLOW_API_TOKEN_FILE: secretPath
      })).toBe("direct-token");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads *_FILE fallback secrets and trims trailing newlines only", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-secret-file-"));

    try {
      const secretPath = path.join(tempDir, "api-token");
      await writeFile(secretPath, " file-secret \r\n", "utf8");

      expect(resolveSecretEnvValue("SITEFLOW_API_TOKEN", {
        SITEFLOW_API_TOKEN_FILE: secretPath
      })).toBe(" file-secret ");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("fails clearly for empty or unreadable *_FILE fallback secrets without exposing content", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-secret-file-"));

    try {
      const emptySecretPath = path.join(tempDir, "empty-token");
      const unreadableSecretPath = path.join(tempDir, "missing-token");
      await writeFile(emptySecretPath, "\n", "utf8");

      expect(() =>
        resolveSecretEnvValue("SITEFLOW_API_TOKEN", {
          SITEFLOW_API_TOKEN_FILE: emptySecretPath
        })
      ).toThrow("SITEFLOW_API_TOKEN_FILE points to an empty secret file");

      expect(() =>
        resolveSecretEnvValue("SITEFLOW_API_TOKEN", {
          SITEFLOW_API_TOKEN_FILE: unreadableSecretPath
        })
      ).toThrow("SITEFLOW_API_TOKEN_FILE points to an unreadable secret file");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the development fallback when no sealing secret is configured outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SITEFLOW_ENV", undefined);
    vi.stubEnv("SITEFLOW_APP_SECRET", undefined);
    vi.stubEnv("SITEFLOW_SEALING_KEY", undefined);

    const sealed = sealSecretValue("dev-fallback-secret");

    expect(unsealSecretValue(sealed)).toBe("dev-fallback-secret");
  });

  it("fails fast in production when no sealing secret is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SITEFLOW_ENV", undefined);
    vi.stubEnv("SITEFLOW_APP_SECRET", undefined);
    vi.stubEnv("SITEFLOW_SEALING_KEY", undefined);

    expect(() => sealSecretValue("production-secret")).toThrow(/SITEFLOW_APP_SECRET.*SITEFLOW_SEALING_KEY/s);
    expect(() => requireProductionSecret()).toThrow(/SITEFLOW_APP_SECRET.*SITEFLOW_SEALING_KEY/s);
  });

  it("rejects weak and placeholder production sealing secrets", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SITEFLOW_ENV", undefined);

    vi.stubEnv("SITEFLOW_APP_SECRET", "short-secret");
    vi.stubEnv("SITEFLOW_SEALING_KEY", undefined);
    expect(() => requireProductionSecret()).toThrow(/at least 32 characters/i);
    expect(() => sealSecretValue("production-secret")).toThrow(/at least 32 characters/i);

    vi.stubEnv("SITEFLOW_APP_SECRET", "replace-with-at-least-32-random-bytes");
    expect(() => requireProductionSecret()).toThrow(/placeholder/i);

    vi.stubEnv("SITEFLOW_APP_SECRET", "siteflow-local-development-sealing-key");
    expect(() => requireProductionSecret()).toThrow(/placeholder/i);
  });

  it("validates named production bearer tokens with the shared strength policy", () => {
    expect(() => assertProductionSecretStrength("short-token", "SITEFLOW_API_TOKEN")).toThrow(/SITEFLOW_API_TOKEN/);
    expect(() => assertProductionSecretStrength("replace-with-at-least-32-random-bytes", "SITEFLOW_METRICS_TOKEN")).toThrow(/SITEFLOW_METRICS_TOKEN/);
    expect(assertProductionSecretStrength("0123456789abcdef0123456789abcdef", "SITEFLOW_API_TOKEN")).toBe("0123456789abcdef0123456789abcdef");
  });

  it("accepts strong production sealing secrets", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SITEFLOW_ENV", undefined);
    vi.stubEnv("SITEFLOW_APP_SECRET", "0123456789abcdef0123456789abcdef");
    vi.stubEnv("SITEFLOW_SEALING_KEY", undefined);

    const sealed = sealSecretValue("production-secret");

    expect(requireProductionSecret()).toBe("0123456789abcdef0123456789abcdef");
    expect(unsealSecretValue(sealed)).toBe("production-secret");
  });

  it("accepts SITEFLOW_APP_SECRET_FILE and legacy SITEFLOW_SEALING_KEY_FILE in production", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "siteflow-sealing-file-"));

    try {
      const appSecretPath = path.join(tempDir, "app-secret");
      const legacySecretPath = path.join(tempDir, "legacy-sealing-key");
      await writeFile(appSecretPath, "0123456789abcdef0123456789abcdef\n", "utf8");
      await writeFile(legacySecretPath, "abcdef0123456789abcdef0123456789\n", "utf8");

      expect(requireProductionSecret({
        NODE_ENV: "production",
        SITEFLOW_APP_SECRET_FILE: appSecretPath
      })).toBe("0123456789abcdef0123456789abcdef");
      expect(resolveSealingSecret(undefined, {
        SITEFLOW_ENV: "production",
        SITEFLOW_SEALING_KEY_FILE: legacySecretPath
      })).toBe("abcdef0123456789abcdef0123456789");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
