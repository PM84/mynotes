import { useAuth } from "./auth";
import { API_BASE } from "./api";
import { pullAll, trySync } from "./sync";

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let attempt = 0;
let stopped = false;

function wsUrl(token: string): string {
  // API_BASE ist normalerweise "/api" oder absolute URL.
  // Für relative Basis nutzen wir location.origin als Anker.
  const base = API_BASE || "";
  let absolute: string;
  if (/^https?:/i.test(base)) {
    absolute = base;
  } else {
    absolute = `${location.origin}${base}`;
  }
  const u = new URL("/ws/notes", absolute);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  // Pfad ggf. mit base-Prefix versehen, da new URL("/ws/notes") absolut ist.
  if (base && base !== "/" && !/^https?:/i.test(base)) {
    const trimmed = base.replace(/\/+$/, "");
    u.pathname = `${trimmed}/ws/notes`;
  } else if (/^https?:/i.test(base)) {
    const baseUrl = new URL(base);
    const trimmed = baseUrl.pathname.replace(/\/+$/, "");
    u.pathname = `${trimmed}/ws/notes`;
  }
  u.searchParams.set("token", token);
  return u.toString();
}

function scheduleReconnect() {
  if (stopped) return;
  if (reconnectTimer) return;
  attempt += 1;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRealtime();
  }, delay);
}

export function connectRealtime() {
  stopped = false;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const auth = useAuth.getState().auth;
  if (!auth?.access) return;
  if (!navigator.onLine) {
    scheduleReconnect();
    return;
  }
  try {
    ws = new WebSocket(wsUrl(auth.access));
  } catch (e) {
    console.warn("ws connect failed", e);
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    attempt = 0;
    void trySync();
    void pullAll();
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "note.upsert" || msg.type === "note.delete") {
        // Wir machen es einfach robust: bei jedem Event komplett ziehen.
        void pullAll();
      }
    } catch {
      // ignore
    }
  };
  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      // ignore
    }
  };
}

export function disconnectRealtime() {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
    ws = null;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    attempt = 0;
    connectRealtime();
  });
}
