import { create } from "zustand";

const TOK_KEY = "mynotes.auth";

type Auth = { access: string; refresh: string; email: string; role: string; userId: string };

type Store = {
  auth: Auth | null;
  setAuth: (a: Auth | null) => void;
};

function parseJwtPayload(token: string): Record<string, unknown> {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch {
    return {};
  }
}

function load(): Auth | null {
  try {
    const raw = localStorage.getItem(TOK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Auth;
    // Migrate old tokens that don't have role/userId
    if (!parsed.role || !parsed.userId) {
      const claims = parseJwtPayload(parsed.access);
      parsed.role = (claims.role as string) || "user";
      parsed.userId = (claims.sub as string) || "";
    }
    return parsed;
  } catch {
    return null;
  }
}

export { parseJwtPayload };

export const useAuth = create<Store>((set) => ({
  auth: load(),
  setAuth: (a) => {
    if (a) localStorage.setItem(TOK_KEY, JSON.stringify(a));
    else localStorage.removeItem(TOK_KEY);
    set({ auth: a });
  },
}));
