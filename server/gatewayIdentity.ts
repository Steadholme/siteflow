import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/**
 * HOLDFAST gateway identity verification.
 *
 * The Sluice gateway (auth=sso routes) strips every inbound X-Auth-* header and
 * injects the verified identity as X-Auth-Subject / X-Auth-Email / X-Auth-Scope /
 * X-Auth-Groups. When GATEWAY_HMAC_KEY is configured on the gateway it also signs
 * the identity into X-Auth-Sig so upstream services can reject spoofed headers on
 * the internal network:
 *
 *   X-Auth-Sig = lowercase_hex(HMAC-SHA256(key, subject + "\n" + groups + "\n" + window))
 *   window     = floor(unix_seconds / 60) as a decimal string
 *
 * Verification accepts the current minute window and the previous one (clock skew
 * and minute-boundary tolerance). This is a byte-exact replica of the contract in
 * sluice/internal/auth (Go) and forge/crates/loom/src/auth.rs (Rust); the shared
 * cross-language test vectors are asserted in gatewayIdentity.test.ts.
 */

const windowMs = 60_000;

function normalizedHeader(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

export function gatewayIdentitySignature(subject: string, groups: string, window: number, key: string) {
  return createHmac("sha256", key).update(`${subject}\n${groups}\n${window}`).digest("hex");
}

/**
 * Semantics (mirrors loom's gateway_identity_ok):
 * - key not configured        -> pass (feature off, backwards compatible)
 * - X-Auth-Subject missing    -> pass (public route / local dev; no identity claimed)
 * - subject present, sig bad  -> reject (spoofed identity headers)
 */
export function gatewayIdentityOk(headers: IncomingHttpHeaders, key: string | undefined, nowMs = Date.now()) {
  if (!key) {
    return true;
  }

  const subject = normalizedHeader(headers, "x-auth-subject");

  if (!subject) {
    return true;
  }

  const sig = normalizedHeader(headers, "x-auth-sig");

  if (!sig) {
    return false;
  }

  const groups = normalizedHeader(headers, "x-auth-groups");
  const currentWindow = Math.floor(nowMs / windowMs);

  return [currentWindow, currentWindow - 1].some((window) => {
    const want = createHmac("sha256", key).update(`${subject}\n${groups}\n${window}`).digest();

    let got: Buffer;

    try {
      got = Buffer.from(sig, "hex");
    } catch {
      return false;
    }

    return got.length === want.length && timingSafeEqual(got, want);
  });
}

export function gatewayIdentityGroups(headers: IncomingHttpHeaders) {
  return normalizedHeader(headers, "x-auth-groups")
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);
}

export function gatewayIdentitySubject(headers: IncomingHttpHeaders) {
  const subject = normalizedHeader(headers, "x-auth-subject");
  return subject ? subject : undefined;
}

export function gatewayIdentityEmail(headers: IncomingHttpHeaders) {
  const email = normalizedHeader(headers, "x-auth-email");
  return email ? email : undefined;
}
