import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { deleteNoteLocal, deleteNoteRecursive, getChildren, reparentChildren, upsertNoteLocal } from "../sync";
import { apiJson } from "../api";
import { toast } from "sonner";
import { AlertTriangle, CheckSquare, FolderTree, Loader2, Plus, Sparkles, Square, Trash2, X } from "lucide-react";

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

  // Delete-Bestätigungsdialog
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string; childCount: number } | null>(null);
  const [deleteStep, setDeleteStep] = useState<"choose" | "confirm-single" | "confirm-reparent" | "confirm-all">("choose");
  const [confirmInput, setConfirmInput] = useState("");

  async function requestDelete(id: string, title: string) {
    const children = await getChildren(id);
    setDeleteStep("choose");
    setConfirmInput("");
    if (children.length === 0) {
      setDeleteTarget({ id, title, childCount: 0 });
    } else {
      setDeleteTarget({ id, title, childCount: children.length });
    }
  }

  function cancelDelete() {
    setDeleteTarget(null);
    setDeleteStep("choose");
    setConfirmInput("");
  }

  async function executeDelete(mode: "single" | "all" | "reparent") {
    if (!deleteTarget) return;
    if (mode === "reparent") {
      await reparentChildren(deleteTarget.id);
      await deleteNoteLocal(deleteTarget.id);
    } else if (mode === "all") {
      await deleteNoteRecursive(deleteTarget.id);
    } else {
      await deleteNoteLocal(deleteTarget.id);
    }
    cancelDelete();
  }

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
                  onClick={() => requestDelete(n.id, n.title || "(ohne Titel)")}
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

      {/* Lösch-Bestätigungsdialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-5">
            <div className="flex items-center gap-2 text-red-600 mb-3">
              <AlertTriangle size={20} />
              <h3 className="font-semibold text-lg">Notiz löschen</h3>
            </div>

            {/* Schritt 1: Auswahl (bei Kindnotizen) */}
            {deleteStep === "choose" && deleteTarget.childCount > 0 && (
              <>
                <p className="text-sm text-slate-700 mb-3">
                  <strong>{deleteTarget.title}</strong> hat{" "}
                  <strong>{deleteTarget.childCount}</strong> untergeordnete{" "}
                  {deleteTarget.childCount === 1 ? "Notiz" : "Notizen"}.
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={() => setDeleteStep("confirm-reparent")}
                    className="w-full px-4 py-2 rounded text-sm bg-slate-100 hover:bg-slate-200 text-left"
                  >
                    <strong>Nur diese Notiz löschen</strong>
                    <span className="block text-xs text-slate-500">
                      Unternotizen werden eine Ebene höher verschoben
                    </span>
                  </button>
                  <button
                    onClick={() => { setConfirmInput(""); setDeleteStep("confirm-all"); }}
                    className="w-full px-4 py-2 rounded text-sm bg-red-50 hover:bg-red-100 text-red-700 text-left"
                  >
                    <strong>Alles löschen</strong>
                    <span className="block text-xs text-red-500">
                      Diese Notiz und alle {deleteTarget.childCount} Unternotizen
                    </span>
                  </button>
                  <button
                    onClick={cancelDelete}
                    className="w-full px-4 py-2 rounded text-sm border hover:bg-slate-50"
                  >
                    Abbrechen
                  </button>
                </div>
              </>
            )}

            {/* Schritt 1: Einfache Bestätigung (ohne Kindnotizen) */}
            {deleteStep === "choose" && deleteTarget.childCount === 0 && (
              <>
                <p className="text-sm text-slate-700 mb-4">
                  Möchtest du <strong>{deleteTarget.title}</strong> wirklich löschen?
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={cancelDelete}
                    className="px-4 py-2 rounded text-sm border hover:bg-slate-50"
                  >
                    Abbrechen
                  </button>
                  <button
                    onClick={() => executeDelete("single")}
                    className="px-4 py-2 rounded text-sm bg-red-600 text-white hover:bg-red-700"
                  >
                    Löschen
                  </button>
                </div>
              </>
            )}

            {/* Schritt 2: Bestätigung für "Nur diese Notiz löschen" */}
            {deleteStep === "confirm-reparent" && (
              <>
                <p className="text-sm text-slate-700 mb-4">
                  Bist du sicher, dass du <strong>{deleteTarget.title}</strong> löschen möchtest?
                  Die {deleteTarget.childCount} Unternotiz{deleteTarget.childCount !== 1 && "en"} werden eine Ebene höher verschoben.
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setDeleteStep("choose")}
                    className="px-4 py-2 rounded text-sm border hover:bg-slate-50"
                  >
                    Zurück
                  </button>
                  <button
                    onClick={() => executeDelete("reparent")}
                    className="px-4 py-2 rounded text-sm bg-red-600 text-white hover:bg-red-700"
                  >
                    Löschen
                  </button>
                </div>
              </>
            )}

            {/* Schritt 2: Bestätigung für "Alles löschen" mit Texteingabe */}
            {deleteStep === "confirm-all" && (
              <>
                <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-3">
                  <strong>Achtung:</strong> Du bist dabei, <strong>{deleteTarget.title}</strong> und
                  alle <strong>{deleteTarget.childCount}</strong> Unternotizen unwiderruflich zu löschen.
                </p>
                <p className="text-sm text-slate-700 mb-2">
                  Bitte tippe <strong className="font-mono">Löschen</strong> zur Bestätigung:
                </p>
                <input
                  type="text"
                  value={confirmInput}
                  onChange={(e) => setConfirmInput(e.target.value)}
                  className="w-full border rounded px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-red-300"
                  placeholder="Löschen"
                  autoFocus
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setDeleteStep("choose")}
                    className="px-4 py-2 rounded text-sm border hover:bg-slate-50"
                  >
                    Zurück
                  </button>
                  <button
                    onClick={() => executeDelete("all")}
                    disabled={confirmInput !== "Löschen"}
                    className="px-4 py-2 rounded text-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Alle löschen
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
