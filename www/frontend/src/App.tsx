import { useEffect, useState } from "react";
import { Routes, Route, Navigate, Link, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { Login } from "./views/Login";
import { Notes } from "./views/Notes";
import { NoteEditor } from "./views/NoteEditor";
import { AssetViewer } from "./views/AssetViewer";
import { AISearch } from "./views/AISearch";
import { Admin } from "./views/Admin";
import { Tasks } from "./views/Tasks";
import { onSyncChange, pendingCount, pullAll, trySync } from "./sync";
import { connectRealtime, disconnectRealtime } from "./realtime";
import { hydrateSearchIndex } from "./searchIndex";
import { refreshAuth } from "./api";
import { CloudOff, Cloud, Settings, Sparkles, FileText, LogOut, KanbanSquare } from "lucide-react";

export function App() {
  const auth = useAuth((s) => s.auth);
  const setAuth = useAuth((s) => s.setAuth);
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const upd = async () => setPending(await pendingCount());
    const off = onSyncChange(upd);
    void upd();
    const onOnline = () => { setOnline(true); void trySync(); void pullAll(); };
    const onOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === "visible" && auth) {
        void refreshAuth();
        void pullAll();
        void trySync();
        connectRealtime();
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
    if (auth) {
      void refreshAuth();
      void pullAll();
      void hydrateSearchIndex();
      connectRealtime();
    } else {
      disconnectRealtime();
    }
    return () => {
      off();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [auth]);

  if (!auth) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-4 py-2 bg-slate-900 text-white">
        <div className="flex items-center gap-4">
          <Link to="/" className="font-bold">MyNotes</Link>
          <NavLink to="/" icon={<FileText size={16} />} label="Notizen" />
          <NavLink to="/tasks" icon={<KanbanSquare size={16} />} label="Aufgaben" />
          <NavLink to="/ai" icon={<Sparkles size={16} />} label="KI-Suche" />
          <NavLink to="/admin" icon={<Settings size={16} />} label="Admin" />
        </div>
        <div className="flex items-center gap-3 text-sm">
          {online ? <Cloud size={16} className="text-emerald-400" /> : <CloudOff size={16} className="text-amber-400" />}
          <span title="ausstehende Synchronisationen">
            {pending > 0 ? `${pending} ausstehend` : online ? "online" : "offline"}
          </span>
          <span className="opacity-70">{auth.email}</span>
          <button onClick={() => setAuth(null)} className="opacity-70 hover:opacity-100" title="Logout">
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-auto">
        <Routes>
          <Route path="/" element={<Notes />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/notes/:id" element={<NoteEditor />} />
          <Route path="/assets/:id" element={<AssetViewer />} />
          <Route path="/ai" element={<AISearch />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function NavLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  const loc = useLocation();
  const active = loc.pathname === to;
  return (
    <Link
      to={to}
      className={`flex items-center gap-1 px-2 py-1 rounded ${active ? "bg-slate-700" : "hover:bg-slate-800"}`}
    >
      {icon} {label}
    </Link>
  );
}
