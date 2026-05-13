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
import { Memos } from "./views/Memos";
import { onSyncChange, pendingCount, pullAll, trySync } from "./sync";
import { connectRealtime, disconnectRealtime } from "./realtime";
import { hydrateSearchIndex } from "./searchIndex";
import { refreshAuth } from "./api";
import { ensureDbUser } from "./db";
import { CloudOff, Cloud, Settings, Sparkles, FileText, LogOut, KanbanSquare, ScrollText } from "lucide-react";

export function App() {
  const auth = useAuth((s) => s.auth);
  const setAuth = useAuth((s) => s.setAuth);
  const loggedIn = !!auth;
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);

  // Effect hängt nur an loggedIn (boolean), NICHT am auth-Objekt.
  // refreshAuth() erzeugt immer neue Token-Objekte → würde als [auth]-Dep
  // eine Endlosschleife auslösen.
  useEffect(() => {
    if (!loggedIn) {
      disconnectRealtime();
      return;
    }

    // Einmalig Token auffrischen (Session verlängern).
    void refreshAuth();

    const init = async () => {
      const a = useAuth.getState().auth;
      if (a?.userId) await ensureDbUser(a.userId);
      await pullAll();
      await hydrateSearchIndex();
    };

    const upd = async () => setPending(await pendingCount());
    const off = onSyncChange(upd);
    void upd();
    const onOnline = () => { setOnline(true); void trySync().then(() => pullAll()); };
    const onOffline = () => setOnline(false);
    const onVisible = () => {
      if (document.visibilityState === "visible" && useAuth.getState().auth) {
        void refreshAuth();
        void pullAll();
        void trySync();
        connectRealtime();
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);

    void init();
    connectRealtime();

    return () => {
      off();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loggedIn]);

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
      <header className="flex items-center justify-between px-2 sm:px-4 py-2 bg-slate-900 text-white gap-2 min-w-0">
        <div className="flex items-center gap-1 sm:gap-4 min-w-0">
          <Link to="/" className="font-bold text-sm sm:text-base whitespace-nowrap">MyNotes</Link>
          <NavLink to="/" icon={<FileText size={16} />} label="Notizen" />
          <NavLink to="/tasks" icon={<KanbanSquare size={16} />} label="Aufgaben" />
          <NavLink to="/memos" icon={<ScrollText size={16} />} label="Memos" />
          <NavLink to="/ai" icon={<Sparkles size={16} />} label="KI-Suche" />
          {auth.role === "admin" && <NavLink to="/admin" icon={<Settings size={16} />} label="Admin" />}
        </div>
        <div className="flex items-center gap-2 sm:gap-3 text-sm min-w-0">
          {online ? <Cloud size={16} className="text-emerald-400 shrink-0" /> : <CloudOff size={16} className="text-amber-400 shrink-0" />}
          {pending > 0 && <span className="whitespace-nowrap">{pending}</span>}
          <span className="opacity-70 hidden sm:inline truncate max-w-[10rem]">{auth.email}</span>
          <button onClick={() => setAuth(null)} className="opacity-70 hover:opacity-100 shrink-0" title="Logout">
            <LogOut size={16} />
          </button>
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-auto">
        <Routes>
          <Route path="/" element={<Notes />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/memos" element={<Memos />} />
          <Route path="/notes/:id" element={<NoteEditor />} />
          <Route path="/assets/:id" element={<AssetViewer />} />
          <Route path="/ai" element={<AISearch />} />
          <Route path="/admin" element={auth.role === "admin" ? <Admin /> : <Navigate to="/" replace />} />
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
      title={label}
    >
      {icon} <span className="hidden sm:inline">{label}</span>
    </Link>
  );
}
