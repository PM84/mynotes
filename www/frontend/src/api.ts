import { useAuth, parseJwtPayload } from "./auth";

export const API_BASE = (import.meta.env.VITE_API_BASE as string) || "";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, msg: string) {
    super(msg);
    this.status = status;
    this.body = body;
  }
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const auth = useAuth.getState().auth;
  const headers = new Headers(init.headers || {});
  if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  if (auth) headers.set("Authorization", `Bearer ${auth.access}`);
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    useAuth.getState().setAuth(null);
  }
  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, body, `${res.status} ${res.statusText}`);
  }
  return body as T;
}

export const apiJson = <T = unknown>(path: string, method: string, data?: unknown) =>
  api<T>(path, { method, body: data !== undefined ? JSON.stringify(data) : undefined });

export async function apiBlob(path: string): Promise<Blob> {
  const auth = useAuth.getState().auth;
  const headers = new Headers();
  if (auth) headers.set("Authorization", `Bearer ${auth.access}`);
  const res = await fetch(`${API_BASE}${path}`, { headers });
  if (res.status === 401) useAuth.getState().setAuth(null);
  if (!res.ok) throw new ApiError(res.status, null, `${res.status} ${res.statusText}`);
  return res.blob();
}

/**
 * Erneuert Access- und Refresh-Token mit dem aktuell gespeicherten Refresh-Token.
 * Wird beim App-Start (Page-Reload) und nach Re-Connect aufgerufen, damit die
 * Session-Lebensdauer wieder auf den vollen Default-Wert gesetzt wird.
 */
export async function refreshAuth(): Promise<boolean> {
  const auth = useAuth.getState().auth;
  if (!auth) return false;
  try {
    const res = await fetch(
      `${API_BASE}/auth/refresh?token=${encodeURIComponent(auth.refresh)}`,
      { method: "POST" }
    );
    if (!res.ok) {
      if (res.status === 401) useAuth.getState().setAuth(null);
      return false;
    }
    const tok = (await res.json()) as { access_token: string; refresh_token: string };
    const claims = parseJwtPayload(tok.access_token);
    useAuth.getState().setAuth({
      access: tok.access_token,
      refresh: tok.refresh_token,
      email: auth.email,
      role: (claims.role as string) || "user",
      userId: (claims.sub as string) || "",
    });
    return true;
  } catch {
    return false;
  }
}
