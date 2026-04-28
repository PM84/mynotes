import { create } from "zustand";

const TOK_KEY = "mynotes.auth";

type Auth = { access: string; refresh: string; email: string };

type Store = {
  auth: Auth | null;
  setAuth: (a: Auth | null) => void;
};

function load(): Auth | null {
  try {
    const raw = localStorage.getItem(TOK_KEY);
    return raw ? (JSON.parse(raw) as Auth) : null;
  } catch {
    return null;
  }
}

export const useAuth = create<Store>((set) => ({
  auth: load(),
  setAuth: (a) => {
    if (a) localStorage.setItem(TOK_KEY, JSON.stringify(a));
    else localStorage.removeItem(TOK_KEY);
    set({ auth: a });
  },
}));
