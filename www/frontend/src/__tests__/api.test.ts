import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { api, apiJson, apiBlob, ApiError } from "../api";
import { useAuth } from "../auth";

const fetchMock = vi.fn();

beforeEach(() => {
  globalThis.fetch = fetchMock as any;
  fetchMock.mockReset();
  useAuth.getState().setAuth({ access: "tok", refresh: "r", email: "a@b.c" });
});

afterEach(() => {
  useAuth.getState().setAuth(null);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api()", () => {
  it("setzt Authorization-Header aus Auth-Store", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await api("/test");
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
  });

  it("löscht auth bei 401", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "x" }, 401));
    await expect(api("/test")).rejects.toBeInstanceOf(ApiError);
    expect(useAuth.getState().auth).toBeNull();
  });

  it("wirft ApiError bei !ok mit Body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "boom" }, 500));
    try {
      await api("/x");
      expect.fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(500);
      expect((e as ApiError).body).toEqual({ detail: "boom" });
    }
  });

  it("apiJson serialisiert Body als JSON mit Content-Type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await apiJson("/x", "POST", { a: 1 });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("apiBlob liefert Blob mit Bearer-Header", async () => {
    const blob = new Blob(["hi"], { type: "text/plain" });
    fetchMock.mockResolvedValueOnce(new Response(blob, { status: 200 }));
    const r = await apiBlob("/asset/1");
    expect(r).toBeDefined();
    expect((r as Blob).size).toBeGreaterThan(0);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
  });
});
