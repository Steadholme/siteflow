import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const envelopePrefix = "sfseal:v1:";
const fallbackSealingSecret = "siteflow-local-development-sealing-key";
const minimumProductionSecretLength = 32;

type SealingSecretEnv = {
  NODE_ENV?: string;
  SITEFLOW_ENV?: string;
  SITEFLOW_APP_SECRET?: string;
  SITEFLOW_APP_SECRET_FILE?: string;
  SITEFLOW_SEALING_KEY?: string;
  SITEFLOW_SEALING_KEY_FILE?: string;
} & Record<string, string | undefined>;

function nonEmptySecret(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function trimTrailingNewlines(value: string) {
  return value.replace(/[\r\n]+$/g, "");
}

export function resolveSecretEnvValue(name: string, env: Record<string, string | undefined> = process.env) {
  const directValue = nonEmptySecret(env[name]);

  if (directValue) {
    return directValue;
  }

  const fileEnvName = `${name}_FILE`;
  const filePath = nonEmptySecret(env[fileEnvName]);

  if (!filePath) {
    return undefined;
  }

  let fileValue: string;

  try {
    fileValue = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`${fileEnvName} points to an unreadable secret file for ${name}.`);
  }

  const normalized = trimTrailingNewlines(fileValue);

  if (normalized.length === 0) {
    throw new Error(`${fileEnvName} points to an empty secret file for ${name}.`);
  }

  return normalized;
}

function isPlaceholderSecret(value: string) {
  const normalized = value.trim().toLowerCase();

  return normalized.startsWith("replace-with-")
    || normalized === "changeme"
    || normalized === "change-me"
    || normalized === "password"
    || normalized === "secret"
    || normalized === fallbackSealingSecret;
}

export function assertProductionSecretStrength(secret: string, name = "SITEFLOW_APP_SECRET") {
  const normalized = secret.trim();

  if (normalized.length < minimumProductionSecretLength || isPlaceholderSecret(normalized)) {
    throw new Error(
      `${name} must be at least ${minimumProductionSecretLength} characters and must not be a placeholder value in production.`
    );
  }

  return normalized;
}

export function isProductionRuntime(env: SealingSecretEnv = process.env) {
  return env.NODE_ENV === "production" || env.SITEFLOW_ENV === "production";
}

export function requireProductionSecret(env: SealingSecretEnv = process.env) {
  const secret = resolveSecretEnvValue("SITEFLOW_APP_SECRET", env) ?? resolveSecretEnvValue("SITEFLOW_SEALING_KEY", env);

  if (!secret) {
    throw new Error(
      "SITEFLOW_APP_SECRET, SITEFLOW_APP_SECRET_FILE, SITEFLOW_SEALING_KEY, or SITEFLOW_SEALING_KEY_FILE is required when NODE_ENV=production or SITEFLOW_ENV=production."
    );
  }

  assertProductionSecretStrength(secret);

  return secret;
}

export function resolveSealingSecret(explicitSecret?: string, env: SealingSecretEnv = process.env) {
  const secret = nonEmptySecret(explicitSecret) ?? resolveSecretEnvValue("SITEFLOW_APP_SECRET", env) ?? resolveSecretEnvValue("SITEFLOW_SEALING_KEY", env);

  if (secret) {
    if (isProductionRuntime(env)) {
      assertProductionSecretStrength(secret);
    }

    return secret;
  }

  if (isProductionRuntime(env)) {
    return requireProductionSecret(env);
  }

  return fallbackSealingSecret;
}

function encryptionKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

function encode(value: Buffer) {
  return value.toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url");
}

export function isSealedSecretValue(value: string) {
  return value.startsWith(envelopePrefix);
}

export function sealSecretValue(value: string, explicitSecret?: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(resolveSealingSecret(explicitSecret)), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${envelopePrefix}${encode(iv)}:${encode(tag)}:${encode(ciphertext)}`;
}

export function unsealSecretValue(value: string, explicitSecret?: string) {
  if (!isSealedSecretValue(value)) {
    return value;
  }

  const parts = value.slice(envelopePrefix.length).split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid sealed secret envelope.");
  }

  const [iv, tag, ciphertext] = parts;

  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(resolveSealingSecret(explicitSecret)), decode(iv));
    decipher.setAuthTag(decode(tag));
    return Buffer.concat([decipher.update(decode(ciphertext)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt sealed secret.");
  }
}
