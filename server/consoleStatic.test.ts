import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveConsoleStatic } from "./consoleStatic.js";

let distDir: string;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  distDir = await mkdtemp(path.join(tmpdir(), "siteflow-console-static-"));
  await writeFile(path.join(distDir, "index.html"), "<!doctype html><title>SiteFlow</title>");
  await mkdir(path.join(distDir, "assets"), { recursive: true });
  await writeFile(path.join(distDir, "assets", "app-abc123.js"), "console.log(1);");

  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://console.test");
    void serveConsoleStatic(request, response, url.pathname, distDir).then((handled) => {
      if (!handled) {
        response.statusCode = 418;
        response.end("unhandled");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(distDir, { recursive: true, force: true });
});

describe("serveConsoleStatic", () => {
  it("serves index.html at the root", async () => {
    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("SiteFlow");
  });

  it("serves hashed assets with immutable caching", async () => {
    const response = await fetch(`${baseUrl}/assets/app-abc123.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
  });

  it("falls back to index.html for SPA routes", async () => {
    const response = await fetch(`${baseUrl}/projects/prj_123`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("SiteFlow");
  });

  it("returns 404 for missing files with extensions", async () => {
    const response = await fetch(`${baseUrl}/assets/missing.js`);

    expect(response.status).toBe(404);
  });

  it("neutralizes path traversal outside dist/", async () => {
    // Normalization confines the path inside dist/: the traversal target is never
    // opened; the request degrades to the SPA fallback (no extension) or 404.
    const fallback = await fetch(`${baseUrl}/..%2f..%2fetc%2fpasswd`);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("SiteFlow");

    const withExtension = await fetch(`${baseUrl}/..%2f..%2fetc%2fpasswd.txt`);
    expect(withExtension.status).toBe(404);
  });

  it("declines non-GET methods so the API keeps handling them", async () => {
    const response = await fetch(`${baseUrl}/`, { method: "POST" });

    expect(response.status).toBe(418);
  });
});
