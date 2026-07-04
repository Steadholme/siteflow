import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createSiteFlowServer } from "./httpServer.js";
import { gatewayIdentitySignature } from "./gatewayIdentity.js";
import type { SiteFlowReadRepository } from "./readRepository.js";

/**
 * Behavior tests for the HOLDFAST gateway identity branch in authorizeRequest:
 * signed X-Auth-* headers from the Sluice gateway replace the operator session
 * as the console's authentication, while bearer tokens stay untouched.
 */

const gatewayKey = "holdfast-gateway-test-key";

function repositoryStub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    createProject: vi.fn().mockResolvedValue({ project: { id: "prj_new" } }),
    ingestGitWebhook: vi.fn().mockResolvedValue({ status: "accepted", buildJobId: "build_1" }),
    resolveTokenPermissions: vi.fn().mockResolvedValue(undefined),
    resolveSessionPermissions: vi.fn().mockResolvedValue(undefined),
    // The serving pipeline probes the artifact route for every host first.
    resolveArtifactRoute: vi.fn().mockResolvedValue(undefined),
    ...overrides
  } as unknown as SiteFlowReadRepository;
}

async function withGatewayServer(
  test: (baseUrl: string, repository: ReturnType<typeof vi.fn> extends never ? never : any) => Promise<void>,
  options: { gatewayHmacKey?: string; gatewayAdminGroups?: string[]; loomCloneBaseUrl?: string; genericSecret?: string } = {}
) {
  const repository = repositoryStub();
  const server = createSiteFlowServer({
    repository,
    version: "0.1.0-test",
    gatewayHmacKey: options.gatewayHmacKey ?? gatewayKey,
    gatewayAdminGroups: options.gatewayAdminGroups ?? ["admins", "infra-admins", "deploy-admins"],
    loomCloneBaseUrl: options.loomCloneBaseUrl,
    gitWebhookSecrets: options.genericSecret ? { generic: options.genericSecret } : undefined,
    rateLimit: false
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    await test(`http://127.0.0.1:${address.port}`, repository);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function gatewayHeaders(subject: string, groups: string, key = gatewayKey) {
  return {
    "x-auth-subject": subject,
    "x-auth-groups": groups,
    "x-auth-email": `${subject}@w33d.xyz`,
    "x-auth-sig": gatewayIdentitySignature(subject, groups, Math.floor(Date.now() / 60_000), key)
  };
}

describe("gateway identity authorization", () => {
  it("accepts a validly signed admin identity for reads", async () => {
    await withGatewayServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects`, {
        headers: gatewayHeaders("usr_alice", "infra-admins")
      });

      expect(response.status).toBe(200);
    });
  });

  it("rejects a tampered or unsigned identity with 401", async () => {
    await withGatewayServer(async (baseUrl) => {
      const badSig = await fetch(`${baseUrl}/api/projects`, {
        headers: { ...gatewayHeaders("usr_alice", "infra-admins"), "x-auth-groups": "infra-admins,extra" }
      });
      expect(badSig.status).toBe(401);

      const noSig = await fetch(`${baseUrl}/api/projects`, {
        headers: { "x-auth-subject": "usr_alice", "x-auth-groups": "infra-admins" }
      });
      expect(noSig.status).toBe(401);
    });
  });

  it("grants read-only scope to non-admin estate users", async () => {
    await withGatewayServer(async (baseUrl) => {
      const read = await fetch(`${baseUrl}/api/projects`, {
        headers: gatewayHeaders("usr_bob", "app-users")
      });
      expect(read.status).toBe(200);

      const write = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { ...gatewayHeaders("usr_bob", "app-users"), "content-type": "application/json", "x-siteflow-csrf": "same-origin" },
        body: JSON.stringify({ name: "demo", slug: "demo" })
      });
      expect(write.status).toBe(403);
    });
  });

  it("honors the configurable product admin group (deploy-admins)", async () => {
    await withGatewayServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { ...gatewayHeaders("usr_carol", "deploy-admins"), "content-type": "application/json", "x-siteflow-csrf": "same-origin" },
        body: JSON.stringify({ name: "demo", slug: "demo" })
      });

      expect(response.status).toBe(201);
    });
  });

  it("still requires the same-origin CSRF header for gateway-authenticated writes", async () => {
    await withGatewayServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { ...gatewayHeaders("usr_alice", "admins"), "content-type": "application/json" },
        body: JSON.stringify({ name: "demo", slug: "demo" })
      });

      expect(response.status).toBe(403);
      expect(((await response.json()) as { message: string }).message).toContain("CSRF");
    });
  });

  it("falls back to normal auth when no identity is claimed", async () => {
    await withGatewayServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/projects`);

      // No bearer token, no gateway identity, no session and no root token
      // configured -> 503 (api token not configured), the stock behavior.
      expect(response.status).toBe(503);
    });
  });
});

describe("loom webhook dialect over the generic provider", () => {
  const secret = "loom-webhook-secret-0123456789abcdef";
  const sha = "0f1e2d3c4b5a69788766554433221100ffeeddcc";

  function loomDelivery(body: string) {
    return {
      method: "POST" as const,
      headers: {
        "content-type": "application/json",
        "x-loom-event": "push",
        "x-loom-delivery": "wd_test1",
        "x-loom-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
      },
      body
    };
  }

  it("accepts a signed loom push and ingests a mapped generic event", async () => {
    const body = JSON.stringify({
      event: "push",
      action: "pushed",
      delivery: "wd_test1",
      repository: { id: "r1", owner: "usr_alice", name: "site-demo", full_name: "usr_alice/site-demo", private: false, default_branch: "main" },
      sender: { subject: "usr_alice" },
      pusher: { subject: "usr_alice" },
      after: sha
    });

    await withGatewayServer(async (baseUrl, repository) => {
      const response = await fetch(`${baseUrl}/api/webhooks/git/generic`, loomDelivery(body));

      expect(response.status).toBe(202);
      expect(repository.ingestGitWebhook).toHaveBeenCalledTimes(1);

      const command = (repository.ingestGitWebhook as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(command.deliveryId).toBe("wd_test1");
      expect(command.event).toMatchObject({
        provider: "generic",
        kind: "push",
        branch: "main",
        commitSha: sha,
        repository: {
          owner: "usr_alice",
          name: "site-demo",
          providerPayload: { remoteUrl: "https://git.w33d.xyz/git/usr_alice/site-demo.git" }
        }
      });
    }, { genericSecret: secret, loomCloneBaseUrl: "https://git.w33d.xyz/git" });
  });

  it("rejects a loom delivery with a bad signature", async () => {
    const body = JSON.stringify({ event: "push", repository: { full_name: "a/b" }, sender: { subject: "usr_a" } });

    await withGatewayServer(async (baseUrl, repository) => {
      const request = loomDelivery(body);
      request.headers["x-loom-signature"] = `sha256=${"0".repeat(64)}`;

      const response = await fetch(`${baseUrl}/api/webhooks/git/generic`, request);

      expect(response.status).toBe(401);
      expect(repository.ingestGitWebhook).not.toHaveBeenCalled();
    }, { genericSecret: secret, loomCloneBaseUrl: "https://git.w33d.xyz/git" });
  });
});
