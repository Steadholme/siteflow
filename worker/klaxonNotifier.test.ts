import { describe, expect, it, vi } from "vitest";
import { createKlaxonBuildNotifier, type BuildEventNotification } from "./klaxonNotifier.js";
import type { QueuedBuildJob } from "./buildWorker.js";

function buildJob(actorId: string): QueuedBuildJob {
  return {
    id: "build_1",
    projectId: "prj_1",
    projectSlug: "site-demo",
    sourceEventId: "src_1",
    sourceEvent: {
      id: "src_1",
      provider: "generic",
      kind: "push",
      branch: "main",
      commitSha: "0f1e2d3c4b5a69788766554433221100ffeeddcc",
      commitMessage: "test",
      commitAuthor: "usr_alice",
      receivedAt: new Date().toISOString(),
      actor: { id: actorId, name: actorId, role: "developer" }
    } as QueuedBuildJob["sourceEvent"],
    repository: {
      provider: "generic",
      owner: "usr_alice",
      name: "site-demo",
      defaultBranch: "main"
    },
    buildSettings: {} as QueuedBuildJob["buildSettings"]
  };
}

async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createKlaxonBuildNotifier", () => {
  it("is disabled unless both env keys are present", () => {
    expect(createKlaxonBuildNotifier({})).toBeUndefined();
    expect(createKlaxonBuildNotifier({ KLAXON_NOTIFY_URL: "http://klaxon:9050/api/notify" })).toBeUndefined();
    expect(createKlaxonBuildNotifier({ KLAXON_INGEST_TOKEN: "tok" })).toBeUndefined();
  });

  it("posts the estate notify contract on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const notify = createKlaxonBuildNotifier(
      { KLAXON_NOTIFY_URL: "http://klaxon:9050/api/notify", KLAXON_INGEST_TOKEN: "tok" },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    const job = buildJob("usr_alice");
    notify?.({
      status: "succeeded",
      job,
      result: {
        job,
        deploymentId: "dep_1",
        previewHost: "demo.example.test",
        previewUrl: "https://demo.example.test",
        artifact: {} as never
      }
    } satisfies BuildEventNotification);
    await flushAsync();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://klaxon:9050/api/notify");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok" });

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      user_sub: "usr_alice",
      source: "siteflow",
      severity: "info",
      url: "https://demo.example.test"
    });
    expect(body.title).toContain("site-demo");
  });

  it("skips synthetic namespaced actors without an estate inbox", async () => {
    const fetchImpl = vi.fn();
    const notify = createKlaxonBuildNotifier(
      { KLAXON_NOTIFY_URL: "http://klaxon:9050/api/notify", KLAXON_INGEST_TOKEN: "tok" },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    notify?.({ status: "failed", job: buildJob("deploy-hook:dh_1"), reason: "boom" });
    await flushAsync();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("notifies bare estate subjects like w33d", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const notify = createKlaxonBuildNotifier(
      { KLAXON_NOTIFY_URL: "http://klaxon:9050/api/notify", KLAXON_INGEST_TOKEN: "tok" },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    notify?.({ status: "failed", job: buildJob("w33d"), reason: "boom" });
    await flushAsync();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;
    expect(body.user_sub).toBe("w33d");
    expect(body.severity).toBe("warning");
  });

  it("swallows delivery failures with a warning (fire-and-forget)", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection refused"));
    const notify = createKlaxonBuildNotifier(
      { KLAXON_NOTIFY_URL: "http://klaxon:9050/api/notify", KLAXON_INGEST_TOKEN: "tok" },
      { fetchImpl: fetchImpl as unknown as typeof fetch, warn }
    );

    expect(() => notify?.({ status: "failed", job: buildJob("usr_bob"), reason: "npm ci failed" })).not.toThrow();
    await flushAsync();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("connection refused"));
  });
});
