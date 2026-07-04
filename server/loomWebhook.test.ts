import { describe, expect, it } from "vitest";
import { isLoomWebhookPayload, loomPayloadToGeneric } from "./loomWebhook.js";

const loomPushPayload = {
  event: "push",
  action: "pushed",
  delivery: "wd_abc123",
  repository: {
    id: "repo_1",
    owner: "usr_alice",
    name: "site-demo",
    full_name: "usr_alice/site-demo",
    private: false,
    default_branch: "main"
  },
  sender: { subject: "usr_alice" },
  pusher: { subject: "usr_alice" }
};

describe("isLoomWebhookPayload", () => {
  it("recognizes the loom push payload shape", () => {
    expect(isLoomWebhookPayload(loomPushPayload)).toBe(true);
  });

  it("passes generic payloads through untouched", () => {
    expect(isLoomWebhookPayload({
      kind: "push",
      commitSha: "a".repeat(40),
      branch: "main",
      repository: { owner: "o", name: "n", remoteUrl: "https://example.test/o/n.git" }
    })).toBe(false);
    expect(isLoomWebhookPayload(null)).toBe(false);
    expect(isLoomWebhookPayload("push")).toBe(false);
  });
});

describe("loomPayloadToGeneric", () => {
  const sha = "0f1e2d3c4b5a69788766554433221100ffeeddcc";

  it("maps the loom payload into the generic webhook shape", async () => {
    const resolved: string[] = [];
    const generic = await loomPayloadToGeneric(loomPushPayload, {
      cloneBaseUrl: "https://git.w33d.xyz/git/",
      resolveBranchTip: async (remoteUrl, branch) => {
        resolved.push(`${remoteUrl}#${branch}`);
        return sha;
      }
    });

    expect(resolved).toEqual(["https://git.w33d.xyz/git/usr_alice/site-demo.git#main"]);
    expect(generic).toMatchObject({
      kind: "push",
      branch: "main",
      commitSha: sha,
      commitAuthor: "usr_alice",
      actor: { id: "usr_alice", name: "usr_alice" },
      repository: {
        owner: "usr_alice",
        name: "site-demo",
        defaultBranch: "main",
        remoteUrl: "https://git.w33d.xyz/git/usr_alice/site-demo.git"
      }
    });
  });

  it("prefers an embedded after SHA over remote resolution", async () => {
    const generic = await loomPayloadToGeneric(
      { ...loomPushPayload, after: sha },
      {
        cloneBaseUrl: "https://git.w33d.xyz/git",
        resolveBranchTip: async () => {
          throw new Error("must not be called");
        }
      }
    );

    expect(generic.commitSha).toBe(sha);
  });

  it("requires the clone base url", async () => {
    await expect(loomPayloadToGeneric(loomPushPayload, {})).rejects.toThrow("SITEFLOW_LOOM_CLONE_BASE_URL");
  });

  it("rejects unsafe owner or repo names", async () => {
    const hostile = {
      ...loomPushPayload,
      repository: { ...loomPushPayload.repository, owner: "../../etc", name: "site-demo" }
    };

    await expect(loomPayloadToGeneric(hostile, { cloneBaseUrl: "https://git.w33d.xyz/git" })).rejects.toThrow("owner/name");
  });
});
