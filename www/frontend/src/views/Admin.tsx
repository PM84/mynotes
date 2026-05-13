import { useEffect, useState } from "react";
import { api, apiJson, apiBlob, API_BASE } from "../api";
import { useAuth } from "../auth";
import { toast } from "sonner";
import { Pencil, Trash2 } from "lucide-react";

type UserRow = { id: string; email: string; role: string };

type Provider = {
  id: number; name: string; adapter: string; base_url: string; has_key: boolean;
  chat_model: string | null; embed_model: string | null; vision_model: string | null;
  is_active_chat: boolean; is_active_embed: boolean; is_active_vision: boolean;
};

type ModelEntry = { id: string; capabilities: string[] };
type Capability = "chat" | "embed" | "vision";

const ADAPTERS = ["openai", "anthropic", "gemini", "ollama", "compatible"];

function ModelSelect(props: {
  capability: Capability;
  label: string;
  value: string;
  onChange: (v: string) => void;
  models: ModelEntry[] | null;
  loading: boolean;
}) {
  const { capability, label, value, onChange, models, loading } = props;
  const filtered = (models ?? []).filter((m) => m.capabilities.includes(capability));
  const listId = `models-${capability}`;
  return (
    <div className="flex flex-col">
      <label className="text-xs text-slate-500 mb-0.5">{label}</label>
      <input
        list={listId}
        className="border rounded px-2 py-1"
        placeholder={loading ? "Modelle laden…" : filtered.length ? "auswählen oder eintippen" : "Modellname"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {filtered.map((m) => (
          <option key={m.id} value={m.id} />
        ))}
      </datalist>
    </div>
  );
}

export function Admin() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<Partial<Provider> & { api_key?: string } | null>(null);
  const [models, setModels] = useState<ModelEntry[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [prompts, setPrompts] = useState<string[]>([]);
  const [activePrompt, setActivePrompt] = useState<string | null>(null);
  const [promptContent, setPromptContent] = useState("");
  const [sessionMinutes, setSessionMinutes] = useState<number>(40320);
  const [sessionMinutesInput, setSessionMinutesInput] = useState<string>("40320");
  const [autoCloseDays, setAutoCloseDays] = useState<number>(30);
  const [autoCloseDaysInput, setAutoCloseDaysInput] = useState<string>("30");
  const [backendVersion, setBackendVersion] = useState<string>("…");
  const [smtp, setSmtp] = useState({ host: "", port: "587", user: "", password: "", from: "", use_tls: true });
  const [users, setUsers] = useState<UserRow[]>([]);
  const [editingUser, setEditingUser] = useState<{ id?: string; email: string; password: string; role: string } | null>(null);

  async function reload() {
    setProviders(await api<Provider[]>("/admin/ai/providers"));
    setPrompts(await api<string[]>("/admin/ai/prompts"));
    try { setUsers(await api<UserRow[]>("/admin/users")); } catch { /* ok */ }
    try {
      const h = await api<{ version: string }>("/healthz");
      setBackendVersion(h.version);
    } catch {
      setBackendVersion("?");
    }
    try {
      const s = await api<{ session_lifetime_minutes: number; auto_close_days: number; smtp_host: string; smtp_port: number; smtp_user: string; smtp_password: string; smtp_from: string; smtp_use_tls: boolean }>("/admin/settings");
      setSessionMinutes(s.session_lifetime_minutes);
      setSessionMinutesInput(String(s.session_lifetime_minutes));
      setAutoCloseDays(s.auto_close_days);
      setAutoCloseDaysInput(String(s.auto_close_days));
      setSmtp({ host: s.smtp_host || "", port: String(s.smtp_port || 587), user: s.smtp_user || "", password: s.smtp_password || "", from: s.smtp_from || "", use_tls: s.smtp_use_tls ?? true });
    } catch {
      // optional
    }
  }
  useEffect(() => { void reload(); }, []);

  async function loadModels() {
    if (!editing) return;
    setModelsLoading(true);
    setModels(null);
    try {
      let res: { models: ModelEntry[] };
      if (editing.id) {
        res = await api<{ models: ModelEntry[] }>(`/admin/ai/providers/${editing.id}/models`);
      } else {
        res = await apiJson<{ models: ModelEntry[] }>(
          "/admin/ai/providers/preview/models",
          "POST",
          {
            adapter: editing.adapter,
            base_url: editing.base_url,
            api_key: editing.api_key || null,
          },
        );
      }
      setModels(res.models);
      toast.success(`${res.models.length} Modelle geladen`);
    } catch (e: any) {
      toast.error("Modelle laden fehlgeschlagen: " + e.message);
    } finally {
      setModelsLoading(false);
    }
  }

  // Modelle automatisch zurücksetzen, wenn Adapter/URL/Key/Provider wechselt.
  useEffect(() => {
    setModels(null);
  }, [editing?.id, editing?.adapter, editing?.base_url, editing?.api_key]);

  async function save() {
    if (!editing) return;
    try {
      await apiJson("/admin/ai/providers", "POST", {
        name: editing.name,
        adapter: editing.adapter,
        base_url: editing.base_url,
        api_key: editing.api_key || null,
        chat_model: editing.chat_model || null,
        embed_model: editing.embed_model || null,
        vision_model: editing.vision_model || null,
        is_active_chat: !!editing.is_active_chat,
        is_active_embed: !!editing.is_active_embed,
        is_active_vision: !!editing.is_active_vision,
      });
      toast.success("Provider gespeichert");
      setEditing(null);
      await reload();
    } catch (e: any) {
      toast.error("Fehler: " + e.message);
    }
  }

  async function test(id: number) {
    try {
      const r = await apiJson<{ healthy: boolean }>(`/admin/ai/providers/${id}/test`, "POST");
      toast.success(r.healthy ? "Provider erreichbar" : "Provider NICHT erreichbar");
    } catch (e: any) {
      toast.error("Fehler: " + e.message);
    }
  }

  async function loadPrompt(name: string) {
    const r = await api<{ name: string; content: string }>(`/admin/ai/prompts/${name}`);
    setActivePrompt(name);
    setPromptContent(r.content);
  }

  async function savePrompt() {
    if (!activePrompt) return;
    await apiJson(`/admin/ai/prompts/${activePrompt}`, "PUT", { content: promptContent });
    toast.success("Prompt gespeichert");
  }

  async function saveSessionMinutes() {
    const m = parseInt(sessionMinutesInput, 10);
    if (!Number.isFinite(m)) {
      toast.error("Bitte ganze Zahl in Minuten eingeben.");
      return;
    }
    try {
      const r = await apiJson<{ session_lifetime_minutes: number }>(
        "/admin/settings",
        "PUT",
        { session_lifetime_minutes: m }
      );
      setSessionMinutes(r.session_lifetime_minutes);
      setSessionMinutesInput(String(r.session_lifetime_minutes));
      toast.success("Sessiondauer gespeichert (gilt ab nächstem Login/Refresh).");
    } catch (e: any) {
      toast.error("Fehler: " + e.message);
    }
  }

  async function saveAutoCloseDays() {
    const d = parseInt(autoCloseDaysInput, 10);
    if (!Number.isFinite(d)) {
      toast.error("Bitte ganze Zahl in Tagen eingeben.");
      return;
    }
    try {
      const r = await apiJson<{ auto_close_days: number }>(
        "/admin/settings",
        "PUT",
        { auto_close_days: d }
      );
      setAutoCloseDays(r.auto_close_days);
      setAutoCloseDaysInput(String(r.auto_close_days));
      toast.success("Auto-Close gespeichert.");
    } catch (e: any) {
      toast.error("Fehler: " + e.message);
    }
  }

  async function saveSmtp() {
    try {
      await apiJson("/admin/settings", "PUT", {
        smtp_host: smtp.host,
        smtp_port: parseInt(smtp.port, 10) || 587,
        smtp_user: smtp.user,
        smtp_password: smtp.password,
        smtp_from: smtp.from,
        smtp_use_tls: smtp.use_tls,
      });
      toast.success("SMTP-Einstellungen gespeichert.");
    } catch (e: any) {
      toast.error("Fehler: " + e.message);
    }
  }

  async function saveUser() {
    if (!editingUser) return;
    try {
      if (editingUser.id) {
        const body: Record<string, string> = {};
        if (editingUser.email) body.email = editingUser.email;
        if (editingUser.password) body.password = editingUser.password;
        if (editingUser.role) body.role = editingUser.role;
        await apiJson(`/admin/users/${editingUser.id}`, "PUT", body);
        toast.success("Benutzer aktualisiert");
      } else {
        await apiJson("/admin/users", "POST", {
          email: editingUser.email,
          password: editingUser.password,
          role: editingUser.role,
        });
        toast.success("Benutzer erstellt");
      }
      setEditingUser(null);
      await reload();
    } catch (e: any) {
      toast.error("Fehler: " + e.message);
    }
  }

  async function deleteUser(u: UserRow) {
    if (!confirm(`Benutzer „${u.email}" wirklich löschen? Alle Daten (Notizen, Aufgaben, Assets) werden unwiderruflich gelöscht.`)) return;
    try {
      await apiJson(`/admin/users/${u.id}`, "DELETE");
      toast.success("Benutzer gelöscht");
      await reload();
    } catch (e: any) {
      toast.error("Fehler: " + e.message);
    }
  }

  function fmtDuration(min: number): string {
    if (min >= 1440) {
      const d = min / 1440;
      return `${Number.isInteger(d) ? d : d.toFixed(1)} Tage`;
    }
    if (min >= 60) {
      const h = min / 60;
      return `${Number.isInteger(h) ? h : h.toFixed(1)} Std.`;
    }
    return `${min} Min.`;
  }

  async function downloadBackup() {
    try {
      const blob = await apiBlob("/admin/backup");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      a.href = url;
      a.download = `mynotes-backup-${ts}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Backup heruntergeladen");
    } catch (e: any) {
      toast.error("Backup fehlgeschlagen: " + e.message);
    }
  }

  async function uploadRestore(file: File) {
    if (
      !confirm(
        `Restore aus „${file.name}“?\n\nALLE bestehenden Notizen, Assets und ` +
          "Provider-Konfigurationen werden überschrieben. Fortfahren?"
      )
    )
      return;
    const fd = new FormData();
    fd.append("file", file);
    const auth = useAuth.getState().auth;
    const res = await fetch(`${API_BASE}/admin/restore`, {
      method: "POST",
      headers: auth ? { Authorization: `Bearer ${auth.access}` } : {},
      body: fd,
    });
    if (!res.ok) {
      const txt = await res.text();
      toast.error(`Restore fehlgeschlagen: ${res.status} ${txt}`);
      return;
    }
    const data = await res.json();
    toast.success(
      `Restore ok: ${Object.values(data.rows ?? {}).reduce((a: number, b: any) => a + (b || 0), 0)} ` +
        `Datensätze, ${data.assets} Assets, ${data.prompts} Prompts.`
    );
    await reload();
  }

  return (
    <div className="p-4 max-w-5xl mx-auto space-y-8">
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold">Benutzer</h2>
          <button
            onClick={() => setEditingUser({ email: "", password: "", role: "user" })}
            className="bg-slate-900 text-white px-3 py-1 rounded"
          >
            + Neu
          </button>
        </div>
        <table className="w-full text-sm bg-white shadow-sm rounded overflow-hidden">
          <thead className="bg-slate-100 text-left">
            <tr><th className="p-2">E-Mail</th><th>Rolle</th><th className="text-right pr-2">Aktionen</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t">
                <td className="p-2">{u.email}</td>
                <td>
                  <span className={`px-1.5 py-0.5 rounded text-xs ${u.role === "admin" ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-700"}`}>
                    {u.role}
                  </span>
                </td>
                <td className="text-right pr-2 space-x-2">
                  <button onClick={() => setEditingUser({ id: u.id, email: u.email, password: "", role: u.role })} className="inline-flex items-center text-xs underline" title="Bearbeiten"><Pencil size={14} /></button>
                  <button onClick={() => deleteUser(u)} className="inline-flex items-center text-xs underline text-red-600" title="Löschen"><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {editingUser && (
          <div className="mt-4 bg-white p-4 rounded shadow space-y-2">
            <h3 className="font-semibold">{editingUser.id ? "Benutzer bearbeiten" : "Neuer Benutzer"}</h3>
            <div className="grid grid-cols-2 gap-2 max-w-lg">
              <input className="border rounded px-2 py-1 col-span-2" placeholder="E-Mail" type="email" value={editingUser.email} onChange={(e) => setEditingUser({ ...editingUser, email: e.target.value })} />
              <input className="border rounded px-2 py-1" placeholder={editingUser.id ? "Neues Passwort (leer = unverändert)" : "Passwort"} type="password" value={editingUser.password} onChange={(e) => setEditingUser({ ...editingUser, password: e.target.value })} />
              <select className="border rounded px-2 py-1" value={editingUser.role} onChange={(e) => setEditingUser({ ...editingUser, role: e.target.value })}>
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditingUser(null)} className="px-3 py-1 border rounded">Abbrechen</button>
              <button onClick={saveUser} className="px-3 py-1 bg-slate-900 text-white rounded">Speichern</button>
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-bold">KI-Provider</h2>
          <button
            onClick={() => setEditing({ name: "", adapter: "openai", base_url: "https://api.openai.com/v1" })}
            className="bg-slate-900 text-white px-3 py-1 rounded"
          >
            + Neu
          </button>
        </div>
        <table className="w-full text-sm bg-white shadow-sm rounded overflow-hidden">
          <thead className="bg-slate-100 text-left">
            <tr><th className="p-2">Name</th><th>Adapter</th><th>Chat</th><th>Embed</th><th>Vision</th><th>Aktiv</th><th></th></tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="p-2 font-medium">{p.name}</td>
                <td>{p.adapter}</td>
                <td>{p.chat_model || "—"}</td>
                <td>{p.embed_model || "—"}</td>
                <td>{p.vision_model || "—"}</td>
                <td>
                  {p.is_active_chat && <span className="px-1 bg-emerald-100 text-emerald-700 rounded text-xs mr-1">Chat</span>}
                  {p.is_active_embed && <span className="px-1 bg-emerald-100 text-emerald-700 rounded text-xs mr-1">Embed</span>}
                  {p.is_active_vision && <span className="px-1 bg-emerald-100 text-emerald-700 rounded text-xs mr-1">Vision</span>}
                </td>
                <td className="text-right pr-2">
                  <button onClick={() => test(p.id)} className="text-xs underline mr-2">Test</button>
                  <button onClick={() => setEditing({ ...p, api_key: "" })} className="text-xs underline">Bearbeiten</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {editing && (
          <div className="mt-4 bg-white p-4 rounded shadow space-y-2">
            <h3 className="font-semibold">{editing.id ? "Provider bearbeiten" : "Neuer Provider"}</h3>
            <div className="grid grid-cols-2 gap-2">
              <input className="border rounded px-2 py-1" placeholder="Name" value={editing.name || ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <select className="border rounded px-2 py-1" value={editing.adapter} onChange={(e) => setEditing({ ...editing, adapter: e.target.value })}>
                {ADAPTERS.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
              <input className="border rounded px-2 py-1 col-span-2" placeholder="Base URL" value={editing.base_url || ""} onChange={(e) => setEditing({ ...editing, base_url: e.target.value })} />
              <input className="border rounded px-2 py-1 col-span-2" placeholder="API-Key (leer lassen, um aktuellen zu behalten)" type="password" value={editing.api_key || ""} onChange={(e) => setEditing({ ...editing, api_key: e.target.value })} />
              <div className="col-span-2 flex items-center justify-between">
                <span className="text-xs text-slate-500">
                  {models ? `${models.length} Modelle geladen` : "Modelle nicht geladen"}
                </span>
                <button
                  type="button"
                  onClick={loadModels}
                  disabled={modelsLoading || !editing.adapter || !editing.base_url}
                  className="text-xs px-2 py-1 border rounded hover:bg-slate-100 disabled:opacity-40"
                >
                  {modelsLoading ? "lädt…" : "Modelle vom Provider laden"}
                </button>
              </div>
              <ModelSelect
                capability="chat"
                label="Chat-Modell"
                value={editing.chat_model || ""}
                onChange={(v) => setEditing({ ...editing, chat_model: v })}
                models={models}
                loading={modelsLoading}
              />
              <ModelSelect
                capability="embed"
                label="Embed-Modell"
                value={editing.embed_model || ""}
                onChange={(v) => setEditing({ ...editing, embed_model: v })}
                models={models}
                loading={modelsLoading}
              />
              <ModelSelect
                capability="vision"
                label="Vision-Modell"
                value={editing.vision_model || ""}
                onChange={(v) => setEditing({ ...editing, vision_model: v })}
                models={models}
                loading={modelsLoading}
              />
            </div>
            <div className="flex gap-3 text-sm">
              <label><input type="checkbox" checked={!!editing.is_active_chat} onChange={(e) => setEditing({ ...editing, is_active_chat: e.target.checked })} /> aktiv (Chat)</label>
              <label><input type="checkbox" checked={!!editing.is_active_embed} onChange={(e) => setEditing({ ...editing, is_active_embed: e.target.checked })} /> aktiv (Embed)</label>
              <label><input type="checkbox" checked={!!editing.is_active_vision} onChange={(e) => setEditing({ ...editing, is_active_vision: e.target.checked })} /> aktiv (Vision)</label>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setEditing(null)} className="px-3 py-1 border rounded">Abbrechen</button>
              <button onClick={save} className="px-3 py-1 bg-slate-900 text-white rounded">Speichern</button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-bold mb-3">Prompts</h2>
        <div className="flex gap-2 mb-2">
          {prompts.map((p) => (
            <button
              key={p}
              onClick={() => loadPrompt(p)}
              className={`px-2 py-1 text-sm border rounded ${activePrompt === p ? "bg-slate-900 text-white" : ""}`}
            >
              {p}
            </button>
          ))}
        </div>
        {activePrompt && (
          <div className="space-y-2">
            <textarea
              className="w-full h-64 border rounded p-2 font-mono text-sm"
              value={promptContent}
              onChange={(e) => setPromptContent(e.target.value)}
            />
            <button onClick={savePrompt} className="px-3 py-1 bg-slate-900 text-white rounded">Speichern</button>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-bold mb-3">Backup &amp; Restore</h2>
        <p className="text-sm text-slate-600 mb-3">
          Vollständige Sicherung aller Inhalte (Notizen, Anhänge, Provider-Konfiguration,
          Prompts) als ZIP-Datei. Restore ist <strong>destruktiv</strong>: bestehende Inhalte
          werden überschrieben.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={downloadBackup}
            className="px-3 py-1 bg-slate-900 text-white rounded"
          >
            Backup herunterladen
          </button>
          <label className="px-3 py-1 border rounded cursor-pointer hover:bg-slate-100">
            Backup einspielen…
            <input
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void uploadRestore(f);
              }}
            />
          </label>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-bold mb-3">Sessiondauer</h2>
        <p className="text-sm text-slate-600 mb-3">
          Lebensdauer des Login-Tokens in Minuten. Default: <strong>40320</strong>{" "}
          (= 4 Wochen). Bei jedem Seitenaufruf (Reload) und beim Sichtbarwerden des
          Tabs wird die Session automatisch auf diesen Wert zurückgesetzt. Erlaubt:
          5 – 525 600 Minuten (1 Jahr). Änderungen wirken erst beim nächsten
          Login/Refresh.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="number"
            min={5}
            max={525600}
            step={1}
            className="border rounded px-2 py-1 w-32"
            value={sessionMinutesInput}
            onChange={(e) => setSessionMinutesInput(e.target.value)}
          />
          <span className="text-sm text-slate-500">
            ≈ {fmtDuration(parseInt(sessionMinutesInput, 10) || sessionMinutes)}
          </span>
          <button
            onClick={saveSessionMinutes}
            className="px-3 py-1 bg-slate-900 text-white rounded"
          >
            Speichern
          </button>
          <span className="text-xs text-slate-400">
            aktuell aktiv: {sessionMinutes} Min. ({fmtDuration(sessionMinutes)})
          </span>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-bold mb-3">Auto-Close (Kanban)</h2>
        <p className="text-sm text-slate-600 mb-3">
          Aufgaben in „Erledigt"-Spalten werden nach dieser Anzahl Tagen automatisch
          geschlossen und aus der Standard-Ansicht ausgeblendet. Wert <strong>0</strong>{" "}
          deaktiviert das Auto-Close. Erlaubt: 0 – 3650 Tage.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="number"
            min={0}
            max={3650}
            step={1}
            className="border rounded px-2 py-1 w-32"
            value={autoCloseDaysInput}
            onChange={(e) => setAutoCloseDaysInput(e.target.value)}
          />
          <span className="text-sm text-slate-500">Tage</span>
          <button
            onClick={saveAutoCloseDays}
            className="px-3 py-1 bg-slate-900 text-white rounded"
          >
            Speichern
          </button>
          <span className="text-xs text-slate-400">
            aktuell: {autoCloseDays} Tage
          </span>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-bold mb-3">E-Mail (SMTP)</h2>
        <p className="text-sm text-slate-600 mb-3">
          SMTP-Einstellungen für den Versand von Aktennotizen per E-Mail. Alle Felder
          leer lassen, um den E-Mail-Versand zu deaktivieren.
        </p>
        <div className="grid grid-cols-2 gap-2 max-w-lg">
          <input className="border rounded px-2 py-1 col-span-2" placeholder="SMTP-Host" value={smtp.host} onChange={(e) => setSmtp({ ...smtp, host: e.target.value })} />
          <input className="border rounded px-2 py-1" placeholder="Port" type="number" value={smtp.port} onChange={(e) => setSmtp({ ...smtp, port: e.target.value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={smtp.use_tls} onChange={(e) => setSmtp({ ...smtp, use_tls: e.target.checked })} /> STARTTLS
          </label>
          <input className="border rounded px-2 py-1 col-span-2" placeholder="Benutzer" value={smtp.user} onChange={(e) => setSmtp({ ...smtp, user: e.target.value })} />
          <input className="border rounded px-2 py-1 col-span-2" placeholder="Passwort" type="password" value={smtp.password} onChange={(e) => setSmtp({ ...smtp, password: e.target.value })} />
          <input className="border rounded px-2 py-1 col-span-2" placeholder="Absender-Adresse (From)" value={smtp.from} onChange={(e) => setSmtp({ ...smtp, from: e.target.value })} />
        </div>
        <button onClick={saveSmtp} className="mt-3 px-3 py-1 bg-slate-900 text-white rounded">Speichern</button>
      </section>

      <section>
        <h2 className="text-lg font-bold mb-3">Version</h2>
        <div className="text-sm text-slate-600 space-y-1">
          <p>Frontend: <code className="bg-slate-100 px-1 rounded">{import.meta.env.VITE_BUILD_SHA ?? "dev"}</code></p>
          <p>Backend: <code className="bg-slate-100 px-1 rounded">{backendVersion}</code></p>
        </div>
      </section>
    </div>
  );
}
