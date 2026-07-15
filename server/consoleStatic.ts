import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/**
 * Minimal static file serving for the SiteFlow console SPA (vite build output in
 * dist/). Only engaged when the request Host matches the configured console host
 * (SITEFLOW_CONSOLE_HOST, e.g. siteflow.w33d.xyz behind the Steadholme gateway).
 * Non-file paths fall back to index.html (SPA router). API and health paths are
 * never routed here — the caller excludes them.
 */

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

function contentTypeFor(filePath: string) {
  return contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function fileStat(filePath: string) {
  try {
    const stats = await stat(filePath);
    return stats.isFile() ? stats : undefined;
  } catch {
    return undefined;
  }
}

function sendFile(request: IncomingMessage, response: ServerResponse, filePath: string, size: number, cacheControl: string) {
  response.statusCode = 200;
  response.setHeader("Content-Type", contentTypeFor(filePath));
  response.setHeader("Content-Length", size);
  response.setHeader("Cache-Control", cacheControl);
  response.setHeader("X-Content-Type-Options", "nosniff");

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath).pipe(response);
}

export async function serveConsoleStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  distDir: string
): Promise<boolean> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const root = path.resolve(distDir);
  const decoded = (() => {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return "/";
    }
  })();

  const requested = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);

  // Path traversal guard: everything served must stay inside dist/.
  if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
    response.statusCode = 404;
    response.end();
    return true;
  }

  if (requested !== root) {
    const stats = await fileStat(requested);

    if (stats) {
      // Vite emits content-hashed filenames under assets/ — cache them hard.
      const immutable = path.relative(root, requested).startsWith(`assets${path.sep}`);
      sendFile(request, response, requested, stats.size, immutable ? "public, max-age=31536000, immutable" : "public, max-age=300");
      return true;
    }

    // Requests that look like files (have an extension) get a real 404 instead
    // of the SPA fallback, so missing assets fail loudly.
    if (path.extname(requested)) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : "Not found.");
      return true;
    }
  }

  const indexPath = path.join(root, "index.html");
  const indexStats = await fileStat(indexPath);

  if (!indexStats) {
    response.statusCode = 503;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(request.method === "HEAD" ? undefined : "SiteFlow console build (dist/) is not present in this image.");
    return true;
  }

  sendFile(request, response, indexPath, indexStats.size, "no-cache");
  return true;
}
