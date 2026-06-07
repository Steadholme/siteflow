import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
const envelopePrefix = "sfseal:v1:";
const fallbackSealingSecret = "siteflow-local-development-sealing-key";
function sealingSecret(explicitSecret) {
    return explicitSecret
        ?? process.env.SITEFLOW_SEALING_KEY
        ?? process.env.SITEFLOW_APP_SECRET
        ?? fallbackSealingSecret;
}
function encryptionKey(secret) {
    return createHash("sha256").update(secret).digest();
}
function encode(value) {
    return value.toString("base64url");
}
function decode(value) {
    return Buffer.from(value, "base64url");
}
export function isSealedSecretValue(value) {
    return value.startsWith(envelopePrefix);
}
export function sealSecretValue(value, explicitSecret) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(sealingSecret(explicitSecret)), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${envelopePrefix}${encode(iv)}:${encode(tag)}:${encode(ciphertext)}`;
}
export function unsealSecretValue(value, explicitSecret) {
    if (!isSealedSecretValue(value)) {
        return value;
    }
    const parts = value.slice(envelopePrefix.length).split(":");
    if (parts.length !== 3) {
        throw new Error("Invalid sealed secret envelope.");
    }
    const [iv, tag, ciphertext] = parts;
    try {
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey(sealingSecret(explicitSecret)), decode(iv));
        decipher.setAuthTag(decode(tag));
        return Buffer.concat([decipher.update(decode(ciphertext)), decipher.final()]).toString("utf8");
    }
    catch {
        throw new Error("Unable to decrypt sealed secret.");
    }
}
