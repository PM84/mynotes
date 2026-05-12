import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiJson } from "../api";
import { searchLocal } from "../searchIndex";
import { Loader2, Search, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import type { LocalNote } from "../db";

type RagSource = { note_id: string; title: string; snippet: string; score: number };

export function AISearch() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<RagSource[]>([]);
  const [localHits, setLocalHits] = useState<LocalNote[]>([]);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Live-Volltextsuche im lokalen Index (sofort, ohne Submit).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hits = q.trim() ? await searchLocal(q, 10) : [];
      if (!cancelled) setLocalHits(hits);
    })();
    return () => {
      cancelled = true;
    };
  }, [q]);

  async function ask() {
    if (!q.trim()) return;
    if (!online) {
      toast.message("Offline – nur lokale Volltext-Treffer verfügbar.");
      return;
    }
    setBusy(true);
    try {
      const r = await apiJson<{ answer: string; sources: RagSource[] }>("/ai/rag", "POST", {
        question: q,
        top_k: 6,
      });
      setAnswer(r.answer);
      setSources(r.sources);
    } catch (e: any) {
      toast.error("Fehler: " + (e.message || ""));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 max-w-3xl mx-auto space-y-4">
      <div className="flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          className="flex-1 border rounded px-3 py-2"
          placeholder="Suche oder Frage an deine Notizen…"
        />
        <button
          disabled={busy || !online}
          onClick={ask}
          className="bg-slate-900 text-white px-4 py-2 rounded disabled:opacity-50 flex items-center gap-1"
          title={online ? "KI-Suche (RAG)" : "Offline – nicht verfügbar"}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} KI-Antwort
        </button>
      </div>
      {!online && (
        <div className="text-amber-600 text-sm">
          Offline – KI-Antwort deaktiviert. Lokale Volltextsuche unten ist verfügbar.
        </div>
      )}

      {/* Lokale Volltext-Treffer (immer, sofort) */}
      {localHits.length > 0 && (
        <div>
          <h3 className="font-semibold mb-2 flex items-center gap-1 text-sm">
            <Search size={14} /> Lokale Treffer ({localHits.length})
          </h3>
          <ul className="space-y-1">
            {localHits.map((n) => (
              <li key={n.id} className="bg-white p-2 rounded shadow-sm">
                <Link to={`/notes/${n.id}`} className="font-medium hover:underline">
                  {n.title || "(ohne Titel)"}
                </Link>
                <div className="text-xs text-slate-500 truncate">
                  {(n.body_md || n.ocr_text || "").slice(0, 160)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {answer && (
        <div className="prose max-w-none bg-white p-4 rounded shadow">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
        </div>
      )}
      {sources.length > 0 && (
        <div>
          <h3 className="font-semibold mb-2">Quellen</h3>
          <ul className="space-y-2">
            {sources.map((s, i) => (
              <li key={i} className="bg-white p-3 rounded shadow-sm">
                <Link to={`/notes/${s.note_id}`} className="font-medium hover:underline">
                  {s.title || "(ohne Titel)"}
                </Link>
                <div className="text-xs text-slate-500 mb-1">Score: {s.score.toFixed(3)}</div>
                <div className="text-sm text-slate-700">{s.snippet}…</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
