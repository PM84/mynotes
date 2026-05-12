import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { storeAssetLocal, upsertNoteLocal } from "../sync";
import { sendLive, subscribeLive } from "../realtime";
import { apiJson } from "../api";
import { toast } from "sonner";
import { ArrowLeft, Columns, FileText, FolderInput, Image as ImageIcon, Maximize2, Minimize2, Paperclip, PencilLine, Save, ScanLine, Sparkles, Tag, X } from "lucide-react";
import "@excalidraw/excalidraw/index.css";

const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw }))
);

export function NoteEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const note = useLiveQuery(() => (id ? db.notes.get(id) : undefined), [id]);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  // Excalidraw-State NICHT in React-State halten (würde bei jedem onChange
  // Rerender → Excalidraw-Rerender → onChange-Loop auslösen). Stattdessen
  // Ref + eigener Save-Timer.
  const excaliRef = useRef<any>(null);
  const excaliSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Excalidraw-API für updateScene() bei eingehenden Live-Frames.
  const excalidrawApiRef = useRef<any>(null);
  // Drosselung des ausgehenden Live-Broadcasts.
  const liveBroadcastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Wird kurz auf true gesetzt, wenn wir gerade eine Remote-Szene anwenden,
  // damit der dadurch ausgelöste onChange nicht zurückbroadcastet.
  const applyingRemoteRef = useRef(false);
  // Verhindert Auto-Save vor dem ersten Hydrate (sonst überschreibt initialer
  // leerer State sofort die geladene Notiz).
  const hydratedRef = useRef(false);

  useEffect(() => {
    hydratedRef.current = false;
  }, [id]);

  useEffect(() => {
    if (!note) return;
    setTitle(note.title);
    setBody(note.body_md ?? "");
    setTags((note.tags ?? []).join(", "));
    excaliRef.current = note.excalidraw ?? null;
    hydratedRef.current = true;
  }, [note?.id]);

  // Ansicht: nur Markdown, Split (default), nur Canvas. Persistiert in
  // localStorage, damit der Benutzer seine Vorzugsansicht behält.
  const [layout, setLayout] = useState<"md" | "split" | "canvas">(() => {
    const v = localStorage.getItem("noteEditor.layout");
    return v === "md" || v === "canvas" ? v : "split";
  });
  useEffect(() => {
    localStorage.setItem("noteEditor.layout", layout);
  }, [layout]);

  // Vollbildmodus: blendet Toolbar + Anhang-Leiste aus, Canvas/Markdown
  // bekommen die volle Höhe. Persistiert in localStorage.
  const [fullscreen, setFullscreen] = useState<boolean>(() => {
    return localStorage.getItem("noteEditor.fullscreen") === "1";
  });
  useEffect(() => {
    localStorage.setItem("noteEditor.fullscreen", fullscreen ? "1" : "0");
  }, [fullscreen]);
  // Esc verlässt den Vollbildmodus.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const initialData = useMemo(
    () => {
      // Beim Re-Mount (Layout-Wechsel) excaliRef bevorzugen — enth\u00e4lt
      // ungespeicherte Zeichnungen, w\u00e4hrend `note.excalidraw` erst nach
      // dem n\u00e4chsten Dexie-Roundtrip aktualisiert ist.
      const src = excaliRef.current ?? note?.excalidraw;
      return {
        elements: src?.elements ?? [],
        appState: {
          // Stift-First: Freihand-Werkzeug + Pen-Mode (Palm-Rejection) aktiv
          currentItemStrokeWidth: 1,
          ...(src?.appState ?? {}),
          activeTool: { type: "freedraw", lastActiveTool: null, locked: false, customType: null },
          penMode: true,
          penDetected: true,
        },
        // Eingebettete Bilder (Excalidraw "image"-Elemente) brauchen ihre
        // Binärdaten in `files`, sonst werden sie als leere Rahmen gerendert.
        files: src?.files ?? undefined,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [note?.id, layout]
  );

  // Refs auf aktuelle Form-Werte, damit save() nicht in Closures veraltet.
  const titleRef = useRef(title);
  const bodyRef = useRef(body);
  const tagsRef = useRef(tags);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { bodyRef.current = body; }, [body]);
  useEffect(() => { tagsRef.current = tags; }, [tags]);

  const save = useCallback(async () => {
    if (!id) return;
    await upsertNoteLocal({
      id,
      title: titleRef.current,
      body_md: bodyRef.current,
      tags: tagsRef.current.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
      excalidraw: excaliRef.current,
    });
  }, [id]);

  // Auto-Save für Text-Felder (Debounced).
  // WICHTIG: Nicht von `note` abhängen — `useLiveQuery` liefert nach jedem
  // Save eine neue Objekt-Referenz und würde sonst eine Endlos-Loop
  // (Save → Dexie-Update → neuer note → Save) auslösen.
  useEffect(() => {
    if (!id || !hydratedRef.current) return;
    const t = setTimeout(() => void save(), 800);
    return () => clearTimeout(t);
  }, [title, body, tags, id, save]);

  const onExcaliChange = useCallback(
    (elements: readonly any[], appState: any, files: any) => {
      // Dateien (eingebettete Bilder) mergen: Excalidraw liefert `files`
      // manchmal als leeres Objekt `{}` (z.B. beim initialen onChange nach
      // Mount), was den `??`-Operator nicht auslöst. Deshalb altes + neues
      // zusammenführen und nur referenzierte Dateien behalten.
      const merged: Record<string, any> = {
        ...(excaliRef.current?.files ?? {}),
        ...(files ?? {}),
      };
      // Nur Dateien behalten, die von einem image-Element referenziert werden.
      const referencedIds = new Set(
        elements
          .filter((e: any) => e.type === "image" && e.fileId)
          .map((e: any) => e.fileId),
      );
      const cleanFiles: Record<string, any> = {};
      for (const [fid, fdata] of Object.entries(merged)) {
        if (referencedIds.has(fid)) cleanFiles[fid] = fdata;
      }
      excaliRef.current = {
        elements,
        appState: { viewBackgroundColor: appState?.viewBackgroundColor },
        files: Object.keys(cleanFiles).length > 0 ? cleanFiles : null,
      };
      // Live-Broadcast (200 ms) – nur wenn die Änderung lokal entstanden ist.
      if (!applyingRemoteRef.current && id) {
        if (liveBroadcastTimer.current) clearTimeout(liveBroadcastTimer.current);
        liveBroadcastTimer.current = setTimeout(() => {
          // Files NICHT mitsenden – zu groß und werden ohnehin per pullAll
          // nachgereicht. Andere Clients sehen Bild-Elemente kurzzeitig leer.
          sendLive(id, { kind: "excalidraw", elements });
        }, 200);
      }
      if (excaliSaveTimer.current) clearTimeout(excaliSaveTimer.current);
      excaliSaveTimer.current = setTimeout(() => void save(), 800);
    },
    [save, id]
  );

  // Eingehende Live-Frames anwenden (kein DB-Roundtrip).
  useEffect(() => {
    if (!id) return;
    const off = subscribeLive(id, (payload) => {
      if (payload?.kind !== "excalidraw" || !Array.isArray(payload.elements)) return;
      const api = excalidrawApiRef.current;
      if (!api) return;
      applyingRemoteRef.current = true;
      try {
        api.updateScene({ elements: payload.elements });
        excaliRef.current = {
          elements: payload.elements,
          appState: excaliRef.current?.appState ?? {},
          files: excaliRef.current?.files ?? null,
        };
      } finally {
        // Excalidraw feuert onChange synchron im nächsten Tick –
        // den Flag erst danach zurücksetzen.
        setTimeout(() => {
          applyingRemoteRef.current = false;
        }, 50);
      }
    });
    return off;
  }, [id]);

  // Refs auf save-Funktion, damit der Unmount-Effekt immer die aktuelle hat.
  const saveRef = useRef(save);
  useEffect(() => { saveRef.current = save; }, [save]);

  useEffect(() => () => {
    if (excaliSaveTimer.current) clearTimeout(excaliSaveTimer.current);
    if (liveBroadcastTimer.current) clearTimeout(liveBroadcastTimer.current);
    // Beim Verlassen der Notiz sofort speichern, damit keine Änderungen
    // (insbesondere Excalidraw-Bilder) durch gecancelte Timer verloren gehen.
    void saveRef.current();
  }, []);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !id) return;
    const aid = await storeAssetLocal(file);
    const cur = await db.notes.get(id);
    await upsertNoteLocal({
      id,
      asset_ids: Array.from(new Set([...(cur?.asset_ids ?? []), aid])),
    });
    e.target.value = "";
    toast.success("Anhang gespeichert (wird hochgeladen, sobald online)");
  }

  const [busy, setBusy] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [canvasMode, setCanvasMode] = useState<"transcribe" | "summary" | "elaborate" | "cleanup">("transcribe");
  const bodyTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // --- Verschieben-Dialog ---
  const [showMove, setShowMove] = useState(false);
  const [moveSearch, setMoveSearch] = useState("");
  const allNotes = useLiveQuery(() => db.notes.toArray(), []);

  /** IDs aller Nachkommen ermitteln (um Zyklen zu verhindern). */
  function getDescendantIds(noteId: string, notes: typeof allNotes): Set<string> {
    const desc = new Set<string>();
    const queue = [noteId];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const n of notes ?? []) {
        if (n.parent_id === cur && !desc.has(n.id)) {
          desc.add(n.id);
          queue.push(n.id);
        }
      }
    }
    return desc;
  }

  const moveTargets = useMemo(() => {
    if (!allNotes || !id) return [];
    const excluded = getDescendantIds(id, allNotes);
    excluded.add(id);
    return allNotes
      .filter((n) => !n.deleted && !excluded.has(n.id))
      .filter((n) => !moveSearch || n.title.toLowerCase().includes(moveSearch.toLowerCase()))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [allNotes, id, moveSearch]);

  async function moveNote(newParentId: string | null) {
    if (!id) return;
    await upsertNoteLocal({ id, parent_id: newParentId });
    setShowMove(false);
    toast.success(newParentId ? "Notiz verschoben" : "Notiz nach Root verschoben");
  }

  // Asset-Liste mit Live-Daten aus Dexie.
  const assets = useLiveQuery(async () => {
    const ids = note?.asset_ids ?? [];
    if (!ids.length) return [];
    return Promise.all(ids.map((aid) => db.assets.get(aid)));
  }, [note?.asset_ids]);

  async function detachAsset(aid: string) {
    if (!id) return;
    const cur = await db.notes.get(id);
    await upsertNoteLocal({
      id,
      asset_ids: (cur?.asset_ids ?? []).filter((x) => x !== aid),
    });
  }

  async function autoTag() {
    if (!id || !navigator.onLine) return;
    setBusy("tag");
    try {
      // Erst online sicherstellen, dass aktuelle Version auf Server ist
      await save();
      const r = await apiJson<{ tags: string[] }>(`/ai/auto_tag?note_id=${id}`, "POST");
      const merged = Array.from(
        new Set([...tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean), ...r.tags])
      ).join(", ");
      setTags(merged);
      toast.success(`${r.tags.length} Tags vorgeschlagen`);
    } catch (e: any) {
      toast.error("Auto-Tag fehlgeschlagen: " + e.message);
    } finally {
      setBusy(null);
    }
  }

  async function summarize() {
    if (!id || !navigator.onLine) return;
    setBusy("sum");
    try {
      await save();
      // Canvas-Bild beilegen, wenn die Zeichnung Inhalte hat – die KI sieht
      // dann Markdown + Skizze gemeinsam und fasst beides zusammen.
      const canvasPayload = await exportCanvasToB64();
      const r = await apiJson<{ summary: string }>("/ai/summarize", "POST", {
        note_ids: [id],
        ...(canvasPayload ?? {}),
      });
      setAiResult(r.summary);
    } catch (e: any) {
      toast.error("Zusammenfassung fehlgeschlagen: " + e.message);
    } finally {
      setBusy(null);
    }
  }

  /** Exportiert die aktuelle Excalidraw-Szene als PNG-base64, oder null wenn leer. */
  async function exportCanvasToB64(): Promise<{ image_b64: string; mime: string } | null> {
    const scene = excaliRef.current;
    const elements = scene?.elements ?? [];
    if (!elements.length) return null;
    const { exportToBlob } = await import("@excalidraw/excalidraw");
    const blob = await exportToBlob({
      elements,
      appState: { ...(scene?.appState ?? {}), exportBackground: true, exportWithDarkMode: false },
      // Binärdaten eingebetteter Bilder mitgeben, sonst werden sie als
      // leere Rahmen exportiert und das Vision-Modell sieht nichts.
      files: scene?.files ?? null,
      mimeType: "image/png",
    });
    const b64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error);
      fr.onload = () => {
        const s = String(fr.result || "");
        const i = s.indexOf(",");
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      fr.readAsDataURL(blob);
    });
    return { image_b64: b64, mime: "image/png" };
  }

  async function canvasToMarkdown() {
    if (!id || !navigator.onLine) return;
    setBusy("canvas");
    try {
      const payload = await exportCanvasToB64();
      if (!payload) {
        toast.error("Zeichenbereich ist leer");
        return;
      }
      const r = await apiJson<{ markdown: string }>("/ai/canvas", "POST", {
        ...payload,
        mode: canvasMode,
      });
      const md = (r.markdown || "").trim();
      if (!md) {
        toast.error("Leeres Ergebnis");
        return;
      }
      // An Cursor-Position einfügen (oder anhängen, wenn Textarea nicht fokussiert).
      const ta = bodyTextareaRef.current;
      const heading = `\n\n<!-- Canvas → ${canvasMode} -->\n${md}\n`;
      if (ta && document.activeElement === ta) {
        const start = ta.selectionStart ?? body.length;
        const end = ta.selectionEnd ?? start;
        const next = body.slice(0, start) + heading + body.slice(end);
        setBody(next);
        // Cursor hinter den Einfügepunkt setzen.
        requestAnimationFrame(() => {
          ta.focus();
          const pos = start + heading.length;
          ta.setSelectionRange(pos, pos);
        });
      } else {
        setBody((b) => (b ? b + heading : md));
      }
      toast.success("In Markdown übernommen");
    } catch (e: any) {
      toast.error("Canvas→KI fehlgeschlagen: " + e.message);
    } finally {
      setBusy(null);
    }
  }

  if (!note) {
    return <div className="p-4 text-slate-500">Notiz wird geladen…</div>;
  }

  return (
    <div className={`flex flex-col h-full ${fullscreen ? "fixed inset-0 z-50 bg-white" : ""}`}>
      {!fullscreen && (
      <div className="flex items-center gap-2 p-2 border-b bg-white">
        <button onClick={() => nav(-1)} className="p-1 hover:bg-slate-100 rounded">
          <ArrowLeft size={18} />
        </button>
        <input
          className="flex-1 px-2 py-1 text-sm border rounded"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="tags, komma, getrennt"
        />
        <label className="p-1 hover:bg-slate-100 rounded cursor-pointer" title="Bild/PDF anhängen">
          <ImageIcon size={18} />
          <input type="file" className="hidden" onChange={onUpload} accept="image/*,application/pdf" />
        </label>
        <button
          onClick={autoTag}
          disabled={busy !== null || !navigator.onLine}
          className="p-1 hover:bg-slate-100 rounded disabled:opacity-30"
          title="Auto-Tags via KI"
        >
          <Tag size={18} />
        </button>
        <button
          onClick={summarize}
          disabled={busy !== null || !navigator.onLine}
          className="p-1 hover:bg-slate-100 rounded disabled:opacity-30"
          title="KI-Zusammenfassung"
        >
          <Sparkles size={18} />
        </button>
        <div className="flex items-center border rounded ml-1" title="Canvas → Markdown via KI">
          <select
            value={canvasMode}
            onChange={(e) => setCanvasMode(e.target.value as any)}
            className="text-xs px-1 py-1 outline-none bg-transparent"
            disabled={busy !== null}
          >
            <option value="transcribe">Transkript</option>
            <option value="summary">Zusammenfassung</option>
            <option value="elaborate">Ausarbeitung</option>
            <option value="cleanup">Bereinigen</option>
          </select>
          <button
            onClick={canvasToMarkdown}
            disabled={busy !== null || !navigator.onLine}
            className="p-1 hover:bg-slate-100 disabled:opacity-30 border-l"
            title="Canvas in Markdown einfügen"
          >
            <ScanLine size={18} />
          </button>
        </div>
        <button onClick={save} className="p-1 hover:bg-slate-100 rounded" title="Jetzt speichern">
          <Save size={18} />
        </button>
        <button
          onClick={() => { setShowMove(true); setMoveSearch(""); }}
          className="p-1 hover:bg-slate-100 rounded"
          title="Notiz verschieben"
        >
          <FolderInput size={18} />
        </button>
        <div className="flex items-center border rounded ml-1" role="group" aria-label="Ansicht">
          <button
            onClick={() => setLayout("md")}
            className={`p-1 ${layout === "md" ? "bg-slate-200" : "hover:bg-slate-100"}`}
            title="Nur Markdown"
            aria-pressed={layout === "md"}
          >
            <FileText size={18} />
          </button>
          <button
            onClick={() => setLayout("split")}
            className={`p-1 ${layout === "split" ? "bg-slate-200" : "hover:bg-slate-100"}`}
            title="Geteilte Ansicht"
            aria-pressed={layout === "split"}
          >
            <Columns size={18} />
          </button>
          <button
            onClick={() => setLayout("canvas")}
            className={`p-1 ${layout === "canvas" ? "bg-slate-200" : "hover:bg-slate-100"}`}
            title="Nur Canvas"
            aria-pressed={layout === "canvas"}
          >
            <PencilLine size={18} />
          </button>
        </div>
      </div>
      )}
      {/* Prominente, inline editierbare Titelzeile direkt unter der Toolbar.
          Bewusst ohne Rahmen/Hintergrund, damit es wie eine Überschrift wirkt. */}
      <div className="flex items-center border-b bg-white">
        <input
          className="flex-1 px-4 py-3 text-2xl font-bold outline-none bg-transparent placeholder:text-slate-300"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Titel der Notiz…"
          aria-label="Titel"
        />
        <button
          onClick={() => setFullscreen((v) => !v)}
          className="p-2 mr-2 hover:bg-slate-100 rounded text-slate-600"
          title={fullscreen ? "Normalansicht (Esc)" : "Vollbild"}
          aria-pressed={fullscreen}
          aria-label={fullscreen ? "Normalansicht" : "Vollbild"}
        >
          {fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
        </button>
      </div>
      {!fullscreen && aiResult && (
        <div className="border-b bg-amber-50 p-3 text-sm relative">
          <button
            onClick={() => setAiResult(null)}
            className="absolute top-2 right-2 text-slate-500 hover:text-slate-900 text-xs"
          >
            ✕
          </button>
          <div className="flex items-center gap-1 font-medium mb-1">
            <FileText size={14} /> KI-Zusammenfassung
          </div>
          <div className="whitespace-pre-wrap">{aiResult}</div>
        </div>
      )}
      {!fullscreen && assets && assets.length > 0 && (
        <div className="border-b bg-slate-50 p-2 flex gap-2 flex-wrap items-center">
          <Paperclip size={14} className="text-slate-500" />
          {assets.map((a) =>
            a ? (
              <div
                key={a.id}
                className="flex items-center gap-1 bg-white border rounded text-xs"
              >
                <Link
                  to={`/assets/${a.id}`}
                  className="px-2 py-1 hover:bg-slate-100 truncate max-w-[16rem]"
                  title={a.filename}
                >
                  {a.mime.startsWith("image/") ? "🖼" : "📄"} {a.filename}
                  {a.uploaded === 0 && <span className="ml-1 text-amber-600">•</span>}
                </Link>
                <button
                  onClick={() => detachAsset(a.id)}
                  className="px-1 py-1 text-slate-400 hover:text-red-600"
                  title="Verknüpfung entfernen"
                >
                  <X size={12} />
                </button>
              </div>
            ) : null
          )}
        </div>
      )}
      <div className="flex flex-1 min-h-0">
        {layout !== "canvas" && (
          <textarea
            ref={bodyTextareaRef}
            className={`${layout === "split" ? "w-1/2 border-r" : "w-full"} p-3 outline-none font-mono text-sm`}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Markdown..."
          />
        )}
        {layout !== "md" && (
          // Excalidraw key wechselt mit Layout, damit es bei Größenwechsel
          // sauber neu mountet (Canvas-Resize ist nicht responsive).
          <div className={layout === "split" ? "w-1/2" : "w-full"}>
            <Suspense fallback={<div className="p-4 text-slate-500">Excalidraw lädt…</div>}>
              <Excalidraw
                key={layout}
                initialData={initialData}
                onChange={onExcaliChange}
                excalidrawAPI={(api) => {
                  excalidrawApiRef.current = api;
                }}
              />
            </Suspense>
          </div>
        )}
      </div>

      {/* Verschieben-Dialog */}
      {showMove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowMove(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Notiz verschieben</h2>
              <button onClick={() => setShowMove(false)} className="p-1 hover:bg-slate-100 rounded">
                <X size={18} />
              </button>
            </div>
            <div className="p-3 border-b">
              <input
                autoFocus
                className="w-full px-3 py-2 border rounded text-sm"
                placeholder="Notiz suchen…"
                value={moveSearch}
                onChange={(e) => setMoveSearch(e.target.value)}
              />
            </div>
            {note.parent_id && (
              <div className="px-3 pt-2 text-xs text-slate-500">
                Aktuell unter: {allNotes?.find((n) => n.id === note.parent_id)?.title || "(ohne Titel)"}
              </div>
            )}
            <ul className="overflow-y-auto flex-1 p-2">
              <li>
                <button
                  onClick={() => moveNote(null)}
                  className={`w-full text-left px-3 py-2 rounded text-sm hover:bg-slate-100 ${
                    !note.parent_id ? "bg-slate-100 font-medium" : ""
                  }`}
                >
                  📁 Root (oberste Ebene)
                </button>
              </li>
              {moveTargets.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => moveNote(n.id)}
                    className={`w-full text-left px-3 py-2 rounded text-sm hover:bg-slate-100 ${
                      note.parent_id === n.id ? "bg-slate-100 font-medium" : ""
                    }`}
                  >
                    📄 {n.title || "(ohne Titel)"}
                    {n.tags?.length ? (
                      <span className="ml-2 text-xs text-slate-400">{n.tags.join(" · ")}</span>
                    ) : null}
                  </button>
                </li>
              ))}
              {moveTargets.length === 0 && (
                <li className="text-sm text-slate-400 text-center py-4">Keine passenden Notizen</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
