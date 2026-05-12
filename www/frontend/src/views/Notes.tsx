import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { deleteNoteLocal, upsertNoteLocal } from "../sync";
import { apiJson } from "../api";
import { toast } from "sonner";
import { CheckSquare, FolderTree, Loader2, Plus, Sparkles, Square, Trash2, X } from "lucide-react";

export function Notes() {
  const [params, setParams] = useSearchParams();
  const parentId = params.get("parent");

  const notes = useLiveQuery(async () => {
    const all = await db.notes.toArray();
    return all
      .filter((n) => !n.deleted && (n.parent_id ?? null) === (parentId ?? null))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }, [parentId]);

  const [parentChain, setParentChain] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    (async () => {
      const chain: { id: string; title: string }[] = [];
      let cur = parentId;
      while (cur) {
        const n = await db.notes.get(cur);
        if (!n) break;
        chain.unshift({ id: n.id, title: n.title || "(ohne Titel)" });
        cur = n.parent_id;
      }
      setParentChain(chain);
    })();
  }, [parentId]);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [contradictions, setContradictions] = useState<string | null>(null);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function analyseContradictions() {
    if (selected.size < 2 || !navigator.onLine) return;
    setBusy(true);
    try {
      const r = await apiJson<{ report: string }>("/ai/contradictions", "POST", {
        note_ids: Array.from(selected),
      });
      setContradictions(r.report);
    } catch (e: any) {
      toast.error("Analyse fehlgeschlagen: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function createNew() {
    const n = await upsertNoteLocal({ title: "Neue Notiz", parent_id: parentId });
    location.hash = `#/notes/${n.id}`;
  }

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <FolderTree size={16} />
          <Link to="/" className="hover:underline">Stamm</Link>
          {parentChain.map((p) => (
            <span key={p.id}>
              {" / "}
              <Link to={`/?parent=${p.id}`} className="hover:underline">{p.title}</Link>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setSelectMode((v) => !v);
              setSelected(new Set());
            }}
            className={`flex items-center gap-1 px-3 py-1 rounded text-sm border ${
              selectMode ? "bg-slate-900 text-white" : "bg-white"
            }`}
            title="Mehrfach-Auswahl für Widerspruchs-Analyse"
          >
            {selectMode ? <CheckSquare size={16} /> : <Square size={16} />} Auswahl
          </button>
          {selectMode && (
            <button
              onClick={analyseContradictions}
              disabled={selected.size < 2 || busy || !navigator.onLine}
              className="flex items-center gap-1 px-3 py-1 rounded text-sm bg-amber-500 text-white disabled:opacity-30"
              title="Ausgewählte Notizen auf Widersprüche prüfen"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />} Widersprüche ({selected.size})
            </button>
          )}
          <button
            onClick={createNew}
            className="flex items-center gap-1 bg-slate-900 text-white px-3 py-1 rounded"
          >
            <Plus size={16} /> Neu
          </button>
        </div>
      </div>

      {contradictions && (
        <div className="mb-4 bg-amber-50 border border-amber-200 p-3 rounded text-sm relative">
          <button
            onClick={() => setContradictions(null)}
            className="absolute top-2 right-2 text-slate-500 hover:text-slate-900"
          >
            <X size={14} />
          </button>
          <div className="flex items-center gap-1 font-medium mb-1">
            <Sparkles size={14} /> KI-Widerspruchs-Analyse
          </div>
          <div className="whitespace-pre-wrap">{contradictions}</div>
        </div>
      )}

      <ul className="space-y-2">
        {(notes || []).map((n) => (
          <li
            key={n.id}
            className={`flex items-center justify-between bg-white rounded shadow-sm ${
              selectMode && selected.has(n.id) ? "ring-2 ring-amber-400" : ""
            }`}
          >
            {selectMode && (
              <button
                onClick={() => toggle(n.id)}
                className="px-3 py-2 text-slate-500 hover:text-slate-900"
              >
                {selected.has(n.id) ? <CheckSquare size={18} /> : <Square size={18} />}
              </button>
            )}
            <Link
              to={`/notes/${n.id}`}
              onClick={(e) => {
                if (selectMode) {
                  e.preventDefault();
                  toggle(n.id);
                }
              }}
              className="flex-1 px-3 py-2"
            >
              <div className="font-medium">{n.title || "(ohne Titel)"}</div>
              <div className="text-xs text-slate-500">
                {n.tags?.join(" · ")}
                {n.dirty ? <span className="ml-2 text-amber-600">• unsynchronisiert</span> : null}
              </div>
            </Link>
            {!selectMode && (
              <>
                <button
                  onClick={() => setParams({ parent: n.id })}
                  className="px-3 py-2 text-slate-500 hover:text-slate-900 text-sm"
                  title="Unterseiten öffnen"
                >
                  <FolderTree size={16} />
                </button>
                <button
                  onClick={() => deleteNoteLocal(n.id)}
                  className="px-3 py-2 text-slate-500 hover:text-red-600"
                  title="Löschen"
                >
                  <Trash2 size={16} />
                </button>
              </>
            )}
          </li>
        ))}
        {notes && notes.length === 0 && (
          <li className="text-slate-500 text-center py-12">Keine Notizen. Erstelle die erste.</li>
        )}
      </ul>
    </div>
  );
}
