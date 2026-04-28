import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { apiJson } from "../api";
import { toast } from "sonner";

export function Login() {
  const setAuth = useAuth((s) => s.setAuth);
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const tok = await apiJson<{ access_token: string; refresh_token: string }>(
        "/auth/login", "POST", { email, password }
      );
      setAuth({ access: tok.access_token, refresh: tok.refresh_token, email });
      nav("/");
    } catch (e: any) {
      toast.error("Login fehlgeschlagen: " + (e.message || ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center justify-center h-full">
      <form onSubmit={submit} className="w-80 space-y-3 p-6 bg-white rounded shadow">
        <h1 className="text-xl font-bold">Anmelden</h1>
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="E-Mail"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="Passwort"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button
          disabled={busy}
          className="w-full bg-slate-900 text-white py-2 rounded disabled:opacity-50"
        >
          {busy ? "Anmelden..." : "Anmelden"}
        </button>
      </form>
    </div>
  );
}
