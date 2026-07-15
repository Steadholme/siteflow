import { describe, expect, it } from "vitest";
import { gatewayIdentityGroups, gatewayIdentityOk, gatewayIdentitySignature, gatewayIdentitySubject } from "./gatewayIdentity.js";

// Cross-language Steadholme gateway HMAC vectors. These MUST match byte-for-byte:
// - sluice/internal/auth/sig_test.go (Go, the signing side)
// - forge/crates/loom/src/auth.rs L333-343 (Rust, a verifying side)
const vectorKey = "test-key";
const aliceVector = {
  subject: "usr_alice",
  groups: "admins,devs",
  window: 1,
  hex: "ddc77236dcfb03dd9f462f7c84e1b25e58f5fc380997695a689e6c3ac4bb3777"
};
const bobVector = {
  subject: "usr_bob",
  groups: "",
  window: 2,
  hex: "930f82fb1224e69c9c5bc46e545c3b108b1eeb6c9078c7a33fc24f30c595f658"
};

describe("gatewayIdentitySignature", () => {
  it("matches the usr_alice cross-language vector", () => {
    expect(gatewayIdentitySignature(aliceVector.subject, aliceVector.groups, aliceVector.window, vectorKey)).toBe(aliceVector.hex);
  });

  it("matches the usr_bob empty-groups cross-language vector", () => {
    expect(gatewayIdentitySignature(bobVector.subject, bobVector.groups, bobVector.window, vectorKey)).toBe(bobVector.hex);
  });
});

describe("gatewayIdentityOk", () => {
  it("accepts the usr_alice vector in its current minute window", () => {
    const headers = {
      "x-auth-subject": aliceVector.subject,
      "x-auth-groups": aliceVector.groups,
      "x-auth-sig": aliceVector.hex
    };

    expect(gatewayIdentityOk(headers, vectorKey, aliceVector.window * 60_000)).toBe(true);
  });

  it("accepts the usr_bob vector one window later (previous-window tolerance)", () => {
    const headers = {
      "x-auth-subject": bobVector.subject,
      "x-auth-sig": bobVector.hex
    };

    expect(gatewayIdentityOk(headers, vectorKey, (bobVector.window + 1) * 60_000)).toBe(true);
  });

  it("rejects the vector two windows later (stale signature)", () => {
    const headers = {
      "x-auth-subject": aliceVector.subject,
      "x-auth-groups": aliceVector.groups,
      "x-auth-sig": aliceVector.hex
    };

    expect(gatewayIdentityOk(headers, vectorKey, (aliceVector.window + 2) * 60_000)).toBe(false);
  });

  it("rejects a subject with a missing or malformed signature", () => {
    expect(gatewayIdentityOk({ "x-auth-subject": "usr_alice" }, vectorKey)).toBe(false);
    expect(gatewayIdentityOk({ "x-auth-subject": "usr_alice", "x-auth-sig": "not-hex" }, vectorKey)).toBe(false);
    expect(gatewayIdentityOk({ "x-auth-subject": "usr_alice", "x-auth-sig": "deadbeef" }, vectorKey)).toBe(false);
  });

  it("rejects when the groups header is tampered with", () => {
    const headers = {
      "x-auth-subject": aliceVector.subject,
      "x-auth-groups": "admins,devs,infra-admins",
      "x-auth-sig": aliceVector.hex
    };

    expect(gatewayIdentityOk(headers, vectorKey, aliceVector.window * 60_000)).toBe(false);
  });

  it("passes when no key is configured (feature off)", () => {
    expect(gatewayIdentityOk({ "x-auth-subject": "usr_alice" }, undefined)).toBe(true);
    expect(gatewayIdentityOk({ "x-auth-subject": "usr_alice" }, "")).toBe(true);
  });

  it("passes when no subject is claimed (public route)", () => {
    expect(gatewayIdentityOk({}, vectorKey)).toBe(true);
  });
});

describe("gateway identity header helpers", () => {
  it("splits and trims the groups header", () => {
    expect(gatewayIdentityGroups({ "x-auth-groups": " admins , deploy-admins ,, devs " })).toEqual(["admins", "deploy-admins", "devs"]);
    expect(gatewayIdentityGroups({})).toEqual([]);
  });

  it("normalizes the subject header", () => {
    expect(gatewayIdentitySubject({ "x-auth-subject": " usr_alice " })).toBe("usr_alice");
    expect(gatewayIdentitySubject({})).toBeUndefined();
  });
});
