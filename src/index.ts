/**
 * Nx self-hosted remote cache server on Cloudflare Workers + R2.
 *
 * Implements the Nx remote cache OpenAPI spec:
 *   PUT /v1/cache/{hash}  — store a cache artifact (write-once; 409 if it exists)
 *   GET /v1/cache/{hash}  — retrieve a cache artifact
 *
 * Auth: `Authorization: Bearer <token>` checked against two secrets:
 *   ACCESS_TOKEN            — read/write (trusted branches)
 *   READ_ONLY_ACCESS_TOKEN  — read only (PRs); PUT returns 403
 */

interface Env {
  CACHE_BUCKET: R2Bucket;
  ACCESS_TOKEN?: string;
  READ_ONLY_ACCESS_TOKEN?: string;
}

const CACHE_PATH = /^\/v1\/cache\/([A-Za-z0-9_-]{1,255})$/;

type AuthResult = "read-write" | "read-only" | null;

async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  if (token.length === 0) return null;

  if (env.ACCESS_TOKEN && (await tokenEquals(token, env.ACCESS_TOKEN))) {
    return "read-write";
  }
  if (env.READ_ONLY_ACCESS_TOKEN && (await tokenEquals(token, env.READ_ONLY_ACCESS_TOKEN))) {
    return "read-only";
  }
  return null;
}

/** Timing-safe token comparison: compare SHA-256 digests so lengths always match. */
async function tokenEquals(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function json(status: number, message: string): Response {
  return Response.json({ message }, { status });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    const match = CACHE_PATH.exec(url.pathname);
    if (!match) return json(404, "Not found");
    const hash = match[1];

    const auth = await authenticate(request, env);
    if (auth === null) return json(401, "Missing or invalid authentication token");

    switch (request.method) {
      case "GET": {
        const object = await env.CACHE_BUCKET.get(hash);
        if (object === null) return json(404, "The record was not found");
        return new Response(object.body, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": object.size.toString(),
          },
        });
      }
      case "PUT": {
        if (auth !== "read-write") {
          return json(403, "Access forbidden (read-only token)");
        }
        if (request.body === null) return json(400, "Missing request body");

        // Write-once: only store if no object exists under this key.
        // `etagDoesNotMatch: "*"` is the binding equivalent of `If-None-Match: *`;
        // put() resolves to null when the precondition fails.
        const result = await env.CACHE_BUCKET.put(hash, request.body, {
          onlyIf: { etagDoesNotMatch: "*" },
        });
        if (result === null) {
          return json(409, "Cannot override an existing record");
        }
        return json(200, "Successfully uploaded the output");
      }
      default:
        return json(405, "Method not allowed");
    }
  },
} satisfies ExportedHandler<Env>;
