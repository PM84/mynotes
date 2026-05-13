import { useEffect, useRef, useState } from "react";
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
import { CloudOff, Cloud, Settings, Sparkles, FileText, LogOut, KanbanSquare, ScrollText, UserCircle } from "lucide-react";

export function App() {
  const auth = useAuth((s) => s.auth);
  const setAuth = useAuth((s) => s.setAuth);
  const loggedIn = !!auth;
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) setAvatarOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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
          <div className="relative" ref={avatarRef}>
            <button
              onClick={() => setAvatarOpen((o) => !o)}
              className="p-1 rounded-full hover:bg-slate-700 transition-colors"
              title={auth.email}
            >
              <UserCircle size={22} />
            </button>
            {avatarOpen && (
              <div className="absolute right-0 top-full mt-2 w-52 bg-white text-slate-800 rounded-lg shadow-lg z-50 py-1 text-sm">
                <div className="px-3 py-2 border-b text-xs text-slate-500 truncate">{auth.email}</div>
                {auth.role === "admin" && (
                  <Link
                    to="/admin"
                    onClick={() => setAvatarOpen(false)}
                    className="flex items-center gap-2 w-full px-3 py-2 hover:bg-slate-100"
                  >
                    <Settings size={16} /> Einstellungen
                  </Link>
                )}
                <button
                  onClick={() => { setAvatarOpen(false); setAuth(null); }}
                  className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-slate-100 text-red-600"
                >
                  <LogOut size={16} /> Abmelden
                </button>
              </div>
            )}
          </div>
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
