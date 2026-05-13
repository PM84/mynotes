import { useCallback, useEffect, useState } from "react";
import { apiJson } from "../api";
import { toast } from "sonner";
import { Link, useSearchParams } from "react-router-dom";
import { FileText, Loader2, Mail, Printer, Search, Send, Trash2, X } from "lucide-react";

type Memo = {
  id: string;
  note_id: string | null;
  note_title: string | null;
  content: string;
  created_at: string;
};

export function Memos() {
  const [params, setParams] = useSearchParams();
  const noteIdParam = params.get("note_id");
  const [memos, setMemos] = useState<Memo[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Email dialog state
  const [emailMemoId, setEmailMemoId] = useState<string | null>(null);
  const [emailRecipient, setEmailRecipient] = useState("");
  const [recentEmails, setRecentEmails] = useState<string[]>([]);
  const [emailSending, setEmailSending] = useState(false);

  // Expanded memo (to view full content)
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async (q: string, noteId: string | null) => {
    setLoading(true);
    try {
      const sp = new URLSearchParams();
      if (q) sp.set("q", q);
      if (noteId) sp.set("note_id", noteId);
      const qs = sp.toString();
      const data = await apiJson<Memo[]>(`/ai/memos${qs ? `?${qs}` : ""}`, "GET");
      setMemos(data);
    } catch (e: any) {
      toast.error("Memos laden fehlgeschlagen: " + e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(debouncedQuery, noteIdParam);
  }, [debouncedQuery, noteIdParam, load]);

  async function deleteMemo(id: string) {
    try {
      await apiJson(`/ai/memos/${id}`, "DELETE");
      setMemos((prev) => prev.filter((m) => m.id !== id));
      toast.success("Memo gelöscht");
    } catch (e: any) {
      toast.error("Löschen fehlgeschlagen: " + e.message);
    }
  }

  async function openEmailDialog(memoId: string) {
    setEmailMemoId(memoId);
    setEmailRecipient("");
    try {
      const a = await apiJson<{ addresses: string[] }>("/ai/memo/addresses", "GET");
      setRecentEmails(a.addresses);
    } catch {
      setRecentEmails([]);
    }
  }

  async function sendEmail() {
    if (!emailMemoId || !emailRecipient.trim()) return;
    setEmailSending(true);
    try {
      await apiJson("/ai/memo/send", "POST", {
        memo_id: emailMemoId,
        recipient: emailRecipient.trim(),
      });
      toast.success("E-Mail gesendet");
      setEmailMemoId(null);
    } catch (e: any) {
      toast.error("E-Mail-Versand fehlgeschlagen: " + e.message);
    } finally {
      setEmailSending(false);
    }
  }

  function printMemo(memo: Memo) {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      toast.error("Popup-Blocker verhindert den Druckdialog");
      return;
    }
    const dateStr = new Date(memo.created_at).toLocaleDateString("de-DE", {
      year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    // Convert markdown-ish content to basic HTML
    const htmlContent = memo.content
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/^- (.+)$/gm, "<li>$1</li>")
      .replace(/\n{2,}/g, "</p><p>")
      .replace(/\n/g, "<br>");
    printWindow.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Aktennotiz</title>
<style>
  body { font-family: serif; max-width: 700px; margin: 2rem auto; line-height: 1.6; color: #222; }
  h1, h2, h3 { margin-top: 1rem; }
  .meta { color: #666; font-size: 0.9em; margin-bottom: 1.5rem; border-bottom: 1px solid #ccc; padding-bottom: 0.5rem; }
  @media print { body { margin: 0; } }
</style></head><body>
<div class="meta">${memo.note_title ? `Notiz: ${memo.note_title}<br>` : ""}Erstellt: ${dateStr}</div>
<div><p>${htmlContent}</p></div>
</body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  const fmt = (iso: string) =>
    new Date(iso).toLocaleDateString("de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });

  return (
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Aktennotizen</h1>

      {noteIdParam && (
        <div className="flex items-center gap-2 mb-3 text-sm text-slate-600 bg-slate-100 rounded px-3 py-2">
          <FileText size={14} />
          <span>Gefiltert nach Notiz</span>
          <button
            onClick={() => setParams({})}
            className="ml-auto text-slate-400 hover:text-slate-700"
            title="Filter entfernen"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Search bar */}
      <div className="relative mb-4">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          className="w-full pl-9 pr-3 py-2 border rounded text-sm"
          placeholder="Memos durchsuchen…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-slate-500 py-8 justify-center">
          <Loader2 size={20} className="animate-spin" /> Laden…
        </div>
      )}

      {!loading && memos.length === 0 && (
        <div className="text-center text-slate-400 py-12">
          {query ? "Keine Memos gefunden" : "Noch keine Aktennotizen vorhanden"}
        </div>
      )}

      <div className="space-y-3">
        {memos.map((m) => {
          const isExpanded = expandedId === m.id;
          const preview = m.content.length > 200 && !isExpanded
            ? m.content.slice(0, 200) + "…"
            : m.content;

          return (
            <div key={m.id} className="border rounded-lg bg-white shadow-sm">
              <div className="flex items-start justify-between p-4 gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <FileText size={14} className="text-slate-400 shrink-0" />
                    {m.note_id ? (
                      <Link
                        to={`/notes/${m.note_id}`}
                        className="text-sm font-medium text-blue-600 hover:underline truncate"
                      >
                        {m.note_title || "(ohne Titel)"}
                      </Link>
                    ) : (
                      <span className="text-sm text-slate-400">(Notiz gelöscht)</span>
                    )}
                    <span className="text-xs text-slate-400 shrink-0">{fmt(m.created_at)}</span>
                  </div>
                  <div
                    className="text-sm text-slate-700 whitespace-pre-wrap cursor-pointer"
                    onClick={() => setExpandedId(isExpanded ? null : m.id)}
                  >
                    {preview}
                  </div>
                  {m.content.length > 200 && (
                    <button
                      className="text-xs text-blue-500 hover:underline mt-1"
                      onClick={() => setExpandedId(isExpanded ? null : m.id)}
                    >
                      {isExpanded ? "Weniger anzeigen" : "Mehr anzeigen"}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => openEmailDialog(m.id)}
                    className="p-1.5 hover:bg-slate-100 rounded text-slate-500 hover:text-blue-600"
                    title="Per E-Mail senden"
                  >
                    <Mail size={16} />
                  </button>
                  <button
                    onClick={() => printMemo(m)}
                    className="p-1.5 hover:bg-slate-100 rounded text-slate-500 hover:text-slate-800"
                    title="Drucken"
                  >
                    <Printer size={16} />
                  </button>
                  <button
                    onClick={() => deleteMemo(m.id)}
                    className="p-1.5 hover:bg-slate-100 rounded text-slate-500 hover:text-red-600"
                    title="Löschen"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* E-Mail-Dialog */}
      {emailMemoId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setEmailMemoId(null)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Memo per E-Mail senden</h2>
              <button onClick={() => setEmailMemoId(null)} className="p-1 hover:bg-slate-100 rounded">
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">Empfänger</label>
                <input
                  autoFocus
                  type="email"
                  className="w-full px-3 py-2 border rounded text-sm"
                  placeholder="email@example.com"
                  value={emailRecipient}
                  onChange={(e) => setEmailRecipient(e.target.value)}
                />
                {recentEmails.length > 0 && (
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {recentEmails.map((addr) => (
                      <button
                        key={addr}
                        onClick={() => setEmailRecipient(addr)}
                        className={`text-xs px-2 py-0.5 rounded border hover:bg-slate-100 ${
                          emailRecipient === addr ? "bg-slate-200 border-slate-400" : ""
                        }`}
                      >
                        {addr}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t">
              <button
                onClick={() => setEmailMemoId(null)}
                className="px-4 py-2 text-sm border rounded hover:bg-slate-100"
              >
                Abbrechen
              </button>
              <button
                onClick={sendEmail}
                disabled={emailSending || !emailRecipient.trim()}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {emailSending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                Senden
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
