import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const RW = "test-rw-token";
const RO = "test-ro-token";

function fetchCache(hash: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return exports.default.fetch(
    new Request(`https://example.com/v1/cache/${hash}`, { ...rest, headers }),
  );
}

describe("health", () => {
  it("responds 200 without authentication", async () => {
    const res = await exports.default.fetch(new Request("https://example.com/health"));
    expect(res.status).toBe(200);
  });
});

describe("routing", () => {
  it("returns 404 for unknown paths", async () => {
    const res = await exports.default.fetch(new Request("https://example.com/v1/other"));
    expect(res.status).toBe(404);
  });

  it("returns 404 for hashes with invalid characters", async () => {
    for (const path of ["a/b", "a%2Fb", "hash!", "ha sh", ""]) {
      const res = await exports.default.fetch(new Request(`https://example.com/v1/cache/${path}`));
      expect(res.status, `path: ${path}`).toBe(404);
    }
  });

  it("returns 405 for unsupported methods", async () => {
    for (const method of ["DELETE", "POST", "HEAD"]) {
      const res = await fetchCache("somehash", { method, token: RW });
      expect(res.status, `method: ${method}`).toBe(405);
    }
  });
});

describe("authentication", () => {
  it("returns 401 without an Authorization header", async () => {
    const res = await fetchCache("somehash");
    expect(res.status).toBe(401);
  });

  it("returns 401 for a non-Bearer scheme", async () => {
    const res = await fetchCache("somehash", {
      headers: { authorization: `Basic ${RW}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown token", async () => {
    const res = await fetchCache("somehash", { token: "wrong-token" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an empty bearer token", async () => {
    const res = await fetchCache("somehash", { token: "" });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/cache/{hash}", () => {
  it("returns 404 when the record does not exist", async () => {
    const res = await fetchCache("missing", { token: RW });
    expect(res.status).toBe(404);
  });

  it("returns the stored artifact with octet-stream headers", async () => {
    const data = crypto.getRandomValues(new Uint8Array(1024));
    await env.CACHE_BUCKET.put("stored", data);

    const res = await fetchCache("stored", { token: RW });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe("1024");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
  });

  it("allows reads with the read-only token", async () => {
    await env.CACHE_BUCKET.put("ro-readable", "content");
    const res = await fetchCache("ro-readable", { token: RO });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("content");
  });
});

describe("PUT /v1/cache/{hash}", () => {
  it("stores the body and returns 200", async () => {
    const res = await fetchCache("newhash", {
      method: "PUT",
      body: "artifact-bytes",
      token: RW,
    });
    expect(res.status).toBe(200);

    const object = await env.CACHE_BUCKET.get("newhash");
    expect(await object?.text()).toBe("artifact-bytes");
  });

  it("returns 409 when the record already exists (write-once)", async () => {
    await env.CACHE_BUCKET.put("existing", "original");

    const res = await fetchCache("existing", {
      method: "PUT",
      body: "overwrite-attempt",
      token: RW,
    });
    expect(res.status).toBe(409);
    // Original content must be untouched
    const object = await env.CACHE_BUCKET.get("existing");
    expect(await object?.text()).toBe("original");
  });

  it("returns 403 for the read-only token", async () => {
    const res = await fetchCache("ro-write", {
      method: "PUT",
      body: "data",
      token: RO,
    });
    expect(res.status).toBe(403);
    expect(await env.CACHE_BUCKET.get("ro-write")).toBeNull();
  });

  it("returns 400 when the body is missing", async () => {
    const res = await fetchCache("nobody", { method: "PUT", token: RW });
    expect(res.status).toBe(400);
  });

  it("round-trips binary content through PUT then GET", async () => {
    const data = crypto.getRandomValues(new Uint8Array(64 * 1024));
    const put = await fetchCache("roundtrip", { method: "PUT", body: data, token: RW });
    expect(put.status).toBe(200);

    const get = await fetchCache("roundtrip", { token: RO });
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(data);
  });

  it("accepts Nx-style numeric hashes", async () => {
    const res = await fetchCache("16638838912024865923", {
      method: "PUT",
      body: "nx-artifact",
      token: RW,
    });
    expect(res.status).toBe(200);
  });
});
