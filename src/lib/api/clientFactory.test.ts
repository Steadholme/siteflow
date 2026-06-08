import { siteflowFixtures } from "@lib/fixtures/siteflow.fixtures";
import { createSiteFlowClient } from "./clientFactory";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json"
    }
  });
}

function createHttpClient() {
  return createSiteFlowClient({
    config: {
      clientMode: "http",
      apiBaseUrl: "https://siteflow.example.com",
      browserTokenFallbackEnabled: true,
      fixtureScenario: "healthy"
    }
  });
}

describe("createSiteFlowClient", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("loads the operator token from sessionStorage", async () => {
    const authorizationHeaders: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
      return jsonResponse(siteflowFixtures.healthy.projectList);
    });
    window.sessionStorage.setItem("siteflow.apiToken", " sf_session_operator_token ");

    const client = createHttpClient();
    await client.listProjects();

    expect(authorizationHeaders).toEqual(["Bearer sf_session_operator_token"]);
  });

  it("does not load the sessionStorage operator token when browser fallback is disabled", async () => {
    const authorizationHeaders: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
      return jsonResponse(siteflowFixtures.healthy.projectList);
    });
    window.sessionStorage.setItem("siteflow.apiToken", "sf_session_operator_token");

    const client = createSiteFlowClient({
      config: {
        clientMode: "http",
        apiBaseUrl: "https://siteflow.example.com",
        browserTokenFallbackEnabled: false,
        fixtureScenario: "healthy"
      }
    });
    await client.listProjects();

    expect(authorizationHeaders).toEqual([null]);
  });

  it("ignores localStorage operator tokens when sessionStorage is empty", async () => {
    const authorizationHeaders: Array<string | null> = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
      return jsonResponse(siteflowFixtures.healthy.projectList);
    });
    window.localStorage.setItem("siteflow.apiToken", "sf_local_operator_token");

    const client = createHttpClient();
    await client.listProjects();

    expect(authorizationHeaders).toEqual([null]);
  });

  it("creates a client without an operator token when sessionStorage throws", async () => {
    const authorizationHeaders: Array<string | null> = [];
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (this === window.sessionStorage && key === "siteflow.apiToken") {
        throw new Error("sessionStorage unavailable");
      }

      return null;
    });
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizationHeaders.push(new Headers(init?.headers).get("authorization"));
      return jsonResponse(siteflowFixtures.healthy.projectList);
    });

    const client = createHttpClient();
    await client.listProjects();

    expect(authorizationHeaders).toEqual([null]);
  });
});
