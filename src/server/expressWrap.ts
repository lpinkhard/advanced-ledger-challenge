/**
 * @file src/server/express.ts
 * @description
 * Express adapter for API routes
 */

import type { RequestHandler, Request as ExpressReq, Response as ExpressRes } from "express";

/** Build an absolute URL for the request */
function buildAbsoluteUrl(req: ExpressReq): string {
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || "localhost";
  const url = req.originalUrl || req.url || "/";
  return `${proto}://${host}${url}`;
}

/** Convert Express headers to WHATWG headers */
function toHeaders(req: ExpressReq): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) {
      for (const vv of v) h.append(k, vv as string);
    } else if (typeof v === "string") {
      h.set(k, v);
    }
  }
  return h;
}

/** Create a WHATWG Request from an Express request */
async function toFetchRequest(req: ExpressReq): Promise<Request> {
  const method = req.method?.toUpperCase() || "GET";
  const url = buildAbsoluteUrl(req);
  const headers = toHeaders(req);

  // Body handling: if Express JSON/body-parser ran, use req.body; else raw stream.
  let bodyInit: BodyInit | null = null;

  // If method typically carries a body and content-type suggests JSON/form, use parsed body if available
  const hasBodyMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (hasBodyMethod) {
    const ct = (headers.get("content-type") || "").toLowerCase();
    if (req.body !== undefined && req.body !== null && typeof req.body !== "string") {
      // Express parser likely parsed JSON/form already
      if (ct.includes("application/json")) {
        bodyInit = JSON.stringify(req.body);
      } else if (ct.includes("application/x-www-form-urlencoded")) {
        const usp = new URLSearchParams();
        for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
          usp.append(k, String(v));
        }
        bodyInit = usp.toString();
      } else {
        // Fallback to JSON for unknown types when body is an object
        bodyInit = JSON.stringify(req.body);
        if (!ct) headers.set("content-type", "application/json");
      }
    } else if (typeof req.body === "string") {
      bodyInit = req.body;
    } else {
      bodyInit = req as unknown as BodyInit;
    }
  }

  return new Request(url, { method, headers, body: bodyInit });
}

/**
 * Wrap a handler for use in Express.
 *
 * @param handler - default export from /api route
 * @param ctxFactory  - function to build the context
 */
export function expressWrap(
  handler: (req: Request, ctx?: any) => Promise<Response>,
  ctxFactory?: (req: ExpressReq) => any
): RequestHandler {
  return async (req: ExpressReq, res: ExpressRes) => {
    try {
      const fReq = await toFetchRequest(req);
      const ctx = ctxFactory ? ctxFactory(req) : undefined;
      const fRes = await handler(fReq, ctx);

      // Copy status & headers
      res.status(fRes.status);
      fRes.headers.forEach((value, key) => res.setHeader(key, value));

      // Stream/pipe the body
      const body = fRes.body;
      if (!body) {
        const text = await fRes.text().catch(() => "");
        return res.end(text);
      }

      const reader = body.getReader();
      const pull = async () => {
        const { value, done } = await reader.read();
        if (done) return res.end();
        res.write(Buffer.isBuffer(value) ? value : Buffer.from(value));
        await pull();
      };
      await pull();
    } catch (err: any) {
      res
        .status(500)
        .json({ error: "Internal Server Error", details: err?.message || String(err) });
    }
  };
}
