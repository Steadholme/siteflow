type NodeCompatRuntimeContext = {
  params: Record<string, string>;
  path: string;
  requestId: string;
  deploymentId: string;
  env: Record<string, string>;
};

type NodeCompatHeaderValue = string | number | readonly string[];
type NodeCompatHeaders = Record<string, NodeCompatHeaderValue | undefined>;
type NodeCompatQuery = Record<string, string | string[]>;

function responseStatusForbidsBody(status: number) {
  return status === 204 || status === 205 || status === 304;
}

function appendMultiValue(target: Record<string, string | string[]>, key: string, value: string) {
  const current = target[key];

  if (current === undefined) {
    target[key] = value;
    return;
  }

  target[key] = Array.isArray(current) ? [...current, value] : [current, value];
}

function requestHeadersObject(headers: Headers) {
  const next: Record<string, string> = {};

  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    next[lowerKey] = next[lowerKey] ? `${next[lowerKey]}, ${value}` : value;
  });

  return next;
}

function requestQueryObject(searchParams: URLSearchParams) {
  const next: NodeCompatQuery = {};

  searchParams.forEach((value, key) => appendMultiValue(next, key, value));
  return next;
}

function decodeCookieValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function requestCookiesObject(cookieHeader: string | null) {
  const cookies: Record<string, string> = {};

  for (const entry of cookieHeader?.split(";") ?? []) {
    const index = entry.indexOf("=");

    if (index <= 0) {
      continue;
    }

    const key = entry.slice(0, index).trim();

    if (!key) {
      continue;
    }

    cookies[key] = decodeCookieValue(entry.slice(index + 1).trim());
  }

  return cookies;
}

function parseRequestBody(requestBody: Buffer | undefined, contentTypeHeader: string | null) {
  if (!requestBody || requestBody.byteLength === 0) {
    return undefined;
  }

  const contentType = contentTypeHeader?.split(";")[0]?.trim().toLowerCase() ?? "";

  if (contentType === "application/json") {
    try {
      return JSON.parse(requestBody.toString("utf8"));
    } catch {
      return requestBody; // leave malformed JSON as the raw Buffer so the handler can choose to 400 it
    }
  }

  if (contentType === "application/x-www-form-urlencoded") {
    return requestQueryObject(new URLSearchParams(requestBody.toString("utf8")));
  }

  if (contentType.startsWith("text/")) {
    return requestBody.toString("utf8");
  }

  return requestBody;
}

function bodyChunk(value: unknown) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }

  return Buffer.from(String(value), "utf8");
}

function applyHeaders(target: Map<string, { key: string; value: NodeCompatHeaderValue }>, headers: NodeCompatHeaders | Headers | undefined) {
  if (!headers) {
    return;
  }

  if (headers instanceof Headers) {
    headers.forEach((value, key) => target.set(key.toLowerCase(), { key, value }));
    return;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      target.set(key.toLowerCase(), { key, value });
    }
  }
}

function responseHeaders(headers: Map<string, { key: string; value: NodeCompatHeaderValue }>) {
  const next = new Headers();

  for (const { key, value } of headers.values()) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        next.append(key, entry);
      }
      continue;
    }

    next.set(key, String(value));
  }

  return next;
}

export function createNodeCompat(runtimeRequest: Request, requestBody: Buffer | undefined, runtimeContext: NodeCompatRuntimeContext) {
  const requestUrl = new URL(runtimeRequest.url);
  const headers = new Map<string, { key: string; value: NodeCompatHeaderValue }>();
  const chunks: Buffer[] = [];
  let statusCode = 200;
  let settled = false;
  let resolveResponse: ((response: Response) => void) | undefined;
  const settledPromise = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return res;
    },
    setHeader(key: string, value: NodeCompatHeaderValue) {
      headers.set(key.toLowerCase(), { key, value });
      return res;
    },
    getHeader(key: string) {
      return headers.get(key.toLowerCase())?.value;
    },
    removeHeader(key: string) {
      headers.delete(key.toLowerCase());
      return res;
    },
    writeHead(code: number, nextHeaders?: NodeCompatHeaders | Headers) {
      statusCode = code;
      applyHeaders(headers, nextHeaders);
      return res;
    },
    write(chunk: unknown) {
      res.headersSent = true;
      chunks.push(bodyChunk(chunk));
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) {
        res.write(chunk);
      }

      finalize();
      return res;
    },
    json(value: unknown) {
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify(value));
    },
    send(value: unknown) {
      if (value === undefined || value === null) {
        return res.end();
      }

      if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        if (!res.getHeader("content-type")) {
          res.setHeader("content-type", "application/octet-stream");
        }

        return res.end(value);
      }

      if (typeof value === "object") {
        return res.json(value);
      }

      if (!res.getHeader("content-type")) {
        res.setHeader("content-type", "text/plain; charset=utf-8");
      }

      return res.end(String(value));
    },
    redirect(statusOrLocation: number | string, location?: string) {
      const code = typeof statusOrLocation === "number" ? statusOrLocation : 302;
      const target = typeof statusOrLocation === "number" ? location : statusOrLocation;
      statusCode = code;

      if (target) {
        res.setHeader("location", target);
      }

      return res.end();
    },
    settled() {
      return settledPromise;
    }
  };
  const finalize = () => {
    if (settled) {
      return;
    }

    settled = true;
    res.headersSent = true;
    resolveResponse?.(new Response(
      responseStatusForbidsBody(statusCode) ? null : Buffer.concat(chunks),
      {
        status: statusCode,
        headers: responseHeaders(headers)
      }
    ));
  };
  const req = {
    method: runtimeRequest.method,
    url: `${requestUrl.pathname}${requestUrl.search}`,
    headers: requestHeadersObject(runtimeRequest.headers),
    query: requestQueryObject(requestUrl.searchParams),
    cookies: requestCookiesObject(runtimeRequest.headers.get("cookie")),
    body: parseRequestBody(requestBody, runtimeRequest.headers.get("content-type")),
    params: runtimeContext.params
  };

  return { req, res };
}
