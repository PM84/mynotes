import { useAuth } from "./auth";

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
