/**
 * @file api/_util.ts
 * @description
 * Shared utilities for API route handlers
 */

/**
 * Require a valid API key via the `X-API-Key` header
 */
export function requireKey(req: Request): Response | null {
  const headerName = "x-api-key";
  const provided = req.headers.get(headerName);
  const expected = process.env.API_KEY?.trim();

  if (!expected) {
    console.error("Missing API_KEY environment variable");
    return new Response(
      JSON.stringify({ error: "Server misconfiguration: API_KEY missing" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  if (!provided || provided !== expected) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  return null;
}

/**
 * Return a standardized JSON response with appropriate headers
 *
 * @param data - Any serializable object
 * @param status - HTTP status code
 */
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Return a formatted error response in JSON form
 *
 * @param message - A short human-readable error
 * @param status - HTTP status code
 * @param details - Full error details
 */
export function error(
  message: string,
  status = 400,
  details?: unknown
): Response {
  const body: Record<string, unknown> = { error: message };
  if (details !== undefined) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Parse JSON body from a request safely.
 * Returns `null` if parsing fails.
 */
export async function parseJson(req: Request): Promise<any | null> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

/**
 * Simple method guard for route handlers
 */
export function allowMethods(
  req: Request,
  allowed: string[]
): boolean {
  return allowed.includes(req.method.toUpperCase());
}

/**
 * Build a 405 Method Not Allowed response with an Allow header
 */
export function methodNotAllowed(allowed: string[]): Response {
  return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
    status: 405,
    headers: {
      "Allow": allowed.join(", "),
      "Content-Type": "application/json",
    },
  });
}
