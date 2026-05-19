import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { storeAssetLocal, upsertNoteLocal, upsertTaskLocal } from "../sync";
import { v4 as uuid } from "uuid";
import { sendLive, subscribeLive } from "../realtime";
import { apiJson, api } from "../api";
import { toast } from "sonner";
import { ArrowLeft, CheckSquare, ChevronDown, Columns, FileText, FolderInput, Image as ImageIcon, ListChecks, Loader2, Maximize2, Minimize2, Palette, Paperclip, PencilLine, Save, ScanLine, ScrollText, Send, Sparkles, Tag, X } from "lucide-react";
import "@excalidraw/excalidraw/index.css";

const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw }))
);

export function NoteEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const note = useLiveQuery(() => (id ? db.notes.get(id) : undefined), [id]);

  // Default-Zoom aus den Admin-Einstellungen (einmalig geladen).
  const [defaultZoom, setDefaultZoom] = useState<number>(0.9);
  useEffect(() => {
    api<{ excalidraw_default_zoom: number }>("/settings/public")
      .then((s) => setDefaultZoom((s.excalidraw_default_zoom ?? 90) / 100))
      .catch(() => {});
  }, []);

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
    lastSavedRef.current = {
      title: note.title,
      body: note.body_md ?? "",
      tags: (note.tags ?? []).join(","),
      excaliElements: excaliDigest(note.excalidraw ?? null),
    };
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

  // Properties-Panel (Farbe/Stiftdicke) im Canvas ein-/ausblenden.
  const [hideProps, setHideProps] = useState<boolean>(() => {
    return localStorage.getItem("noteEditor.hideProps") === "1";
  });
  useEffect(() => {
    localStorage.setItem("noteEditor.hideProps", hideProps ? "1" : "0");
  }, [hideProps]);

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
      const savedAppState = src?.appState ?? {};
      // Default-Zoom aus Admin-Einstellungen, gespeicherten Zoom beibehalten.
      const zoom = savedAppState.zoom ?? { value: defaultZoom };
      return {
        elements: src?.elements ?? [],
        appState: {
          // Stift-First: Freihand-Werkzeug + Pen-Mode (Palm-Rejection) aktiv
          currentItemStrokeWidth: 1,
          gridModeEnabled: true,
          ...savedAppState,
          zoom,
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
    [note?.id, layout, defaultZoom]
  );

  // Refs auf aktuelle Form-Werte, damit save() nicht in Closures veraltet.
  const titleRef = useRef(title);
  const bodyRef = useRef(body);
  const tagsRef = useRef(tags);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { bodyRef.current = body; }, [body]);
  useEffect(() => { tagsRef.current = tags; }, [tags]);

  // Snapshot of last-saved values to avoid creating pending ops when nothing changed.
  const lastSavedRef = useRef<{ title: string; body: string; tags: string; excaliElements: string } | null>(null);

  /** Stabile Kurzform der Excalidraw-Elemente für Dirty-Check. */
  const excaliDigest = (scene: any): string => {
    const els = scene?.elements;
    if (!els || !els.length) return "";
    // Jedes Element hat einen version-Counter – die Summe ist ein schneller
    // Fingerprint, der billiger als JSON.stringify ist.
    let s = els.length.toString();
    for (const e of els) s += "," + (e.id ?? "") + ":" + (e.version ?? 0) + (e.isDeleted ? "d" : "");
    return s;
  };

  const save = useCallback(async () => {
    if (!id) return;
    const curTitle = titleRef.current;
    const curBody = bodyRef.current;
    const curTags = tagsRef.current.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).join(",");
    const curExcali = excaliRef.current;
    const curDigest = excaliDigest(curExcali);

    const last = lastSavedRef.current;
    if (last
      && last.title === curTitle
      && last.body === curBody
      && last.tags === curTags
      && last.excaliElements === curDigest
    ) {
      return; // nothing changed
    }
    lastSavedRef.current = { title: curTitle, body: curBody, tags: curTags, excaliElements: curDigest };
    await upsertNoteLocal({
      id,
      title: curTitle,
      body_md: curBody,
      tags: curTags.split(",").filter(Boolean),
      excalidraw: curExcali,
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
        appState: {
          viewBackgroundColor: appState?.viewBackgroundColor,
          gridModeEnabled: appState?.gridModeEnabled ?? true,
        },
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
  const [canvasMode, setCanvasMode] = useState<"transcribe" | "summary" | "elaborate" | "cleanup" | "memo">("transcribe");
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const aiMenuRef = useRef<HTMLDivElement>(null);
  const bodyTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // --- Verschieben-Dialog ---
  const [showMove, setShowMove] = useState(false);
  const [moveSearch, setMoveSearch] = useState("");
  const allNotes = useLiveQuery(() => db.notes.toArray(), []);

  // --- E-Mail-Dialog ---
  const [showEmail, setShowEmail] = useState(false);
  const [memoId, setMemoId] = useState<string | null>(null);
  const [memoText, setMemoText] = useState("");
  const [emailRecipient, setEmailRecipient] = useState("");
  const [recentEmails, setRecentEmails] = useState<string[]>([]);
  const [emailSending, setEmailSending] = useState(false);

  // --- AI-Menü schließen bei Klick außerhalb ---
  useEffect(() => {
    if (!aiMenuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) {
        setAiMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [aiMenuOpen]);

  // --- Memo-Existenz prüfen ---
  const [hasMemo, setHasMemo] = useState(false);
  useEffect(() => {
    if (!id) return;
    setHasMemo(false);
    apiJson<{ id: string }[]>(`/ai/memos?note_id=${id}`, "GET")
      .then((data) => setHasMemo(data.length > 0))
      .catch(() => {});
  }, [id]);

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
    // Gelöschte Elemente herausfiltern – Excalidraw behält sie mit
    // isDeleted:true im Array; ohne Filter sieht das Vision-Modell
    // bereits gelöschte Striche im exportierten Bild.
    const elements = (scene?.elements ?? []).filter((e: any) => !e.isDeleted);
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

  async function extractTasks() {
    if (!id || !navigator.onLine) return;
    setBusy("extract");
    try {
      await save();
      const canvasPayload = await exportCanvasToB64();
      const r = await apiJson<{ created: number; updated: number; marked_dnf: number }>(
        "/ai/extract_tasks",
        "POST",
        { note_id: id, ...(canvasPayload ?? {}) },
      );
      const parts: string[] = [];
      if (r.created) parts.push(`${r.created} erstellt`);
      if (r.updated) parts.push(`${r.updated} aktualisiert`);
      if (r.marked_dnf) parts.push(`${r.marked_dnf} als DNF markiert`);
      toast.success(parts.length ? `Aufgaben: ${parts.join(", ")}` : "Keine neuen Aufgaben erkannt");
    } catch (e: any) {
      toast.error("Aufgaben-Extraktion fehlgeschlagen: " + e.message);
    } finally {
      setBusy(null);
    }
  }

  async function generateMemo() {
    if (!id || !navigator.onLine) return;
    setBusy("memo");
    try {
      await save();
      const canvasPayload = await exportCanvasToB64();
      const r = await apiJson<{ id: string; content: string }>("/ai/memo", "POST", {
        note_id: id,
        ...(canvasPayload ?? {}),
      });
      setMemoId(r.id);
      setMemoText(r.content);
      setHasMemo(true);
      // Letzte Adressen laden
      try {
        const a = await apiJson<{ addresses: string[] }>("/ai/memo/addresses", "GET");
        setRecentEmails(a.addresses);
      } catch { setRecentEmails([]); }
      setEmailRecipient("");
      setShowEmail(true);
    } catch (e: any) {
      toast.error("Aktennotiz-Generierung fehlgeschlagen: " + e.message);
    } finally {
      setBusy(null);
    }
  }

  async function sendMemoEmail() {
    if (!memoId || !emailRecipient.trim()) return;
    setEmailSending(true);
    try {
      await apiJson("/ai/memo/send", "POST", {
        memo_id: memoId,
        recipient: emailRecipient.trim(),
      });
      toast.success("E-Mail gesendet");
      setShowEmail(false);
    } catch (e: any) {
      toast.error("E-Mail-Versand fehlgeschlagen: " + e.message);
    } finally {
      setEmailSending(false);
    }
  }

  if (!note) {
    return <div className="p-4 text-slate-500">Notiz wird geladen…</div>;
  }

  return (
    <div className={`flex flex-col h-full ${fullscreen ? "fixed inset-0 z-50 bg-white" : ""}`}>
      {!fullscreen && (
      <div className="flex flex-wrap items-center gap-1 sm:gap-2 p-2 border-b bg-white">
        <button onClick={() => nav(-1)} className="p-1 hover:bg-slate-100 rounded">
          <ArrowLeft size={18} />
        </button>
        <input
          className="flex-1 min-w-[8rem] px-2 py-1 text-sm border rounded"
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
          {busy === "tag" ? <Loader2 size={18} className="animate-spin" /> : <Tag size={18} />}
        </button>
        {/* KI-Dropdown */}
        <div className="relative" ref={aiMenuRef}>
          <button
            onClick={() => setAiMenuOpen((o) => !o)}
            disabled={busy !== null || !navigator.onLine}
            className="flex items-center gap-0.5 p-1 hover:bg-slate-100 rounded disabled:opacity-30"
            title="KI-Aktionen"
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Sparkles size={18} />}
            <ChevronDown size={14} />
          </button>
          {aiMenuOpen && (
            <div className="absolute right-0 top-full mt-1 w-56 bg-white border rounded-lg shadow-lg z-50 py-1 text-sm">
              <button
                onClick={() => { setAiMenuOpen(false); summarize(); }}
                className="w-full text-left px-3 py-2 hover:bg-slate-100 flex items-center gap-2"
              >
                <Sparkles size={16} /> Zusammenfassung
              </button>
              <div className="border-t my-1" />
              <div className="px-3 py-1 text-xs text-slate-400 font-medium">Canvas-Aktion</div>
              <div className="px-3 py-1.5">
                <select
                  value={canvasMode}
                  onChange={(e) => setCanvasMode(e.target.value as any)}
                  className="w-full text-sm px-2 py-1 border rounded bg-white"
                >
                  <option value="transcribe">Transkript</option>
                  <option value="summary">Zusammenfassung</option>
                  <option value="elaborate">Ausarbeitung</option>
                  <option value="cleanup">Bereinigen</option>
                  <option value="memo">Memo erstellen</option>
                </select>
              </div>
              <button
                onClick={() => { setAiMenuOpen(false); canvasMode === "memo" ? generateMemo() : canvasToMarkdown(); }}
                className="w-full text-left px-3 py-2 hover:bg-slate-100 flex items-center gap-2"
              >
                <ScanLine size={16} /> {canvasMode === "memo" ? "Aktennotiz erstellen" : "Canvas verarbeiten"}
              </button>
              <div className="border-t my-1" />
              <button
                onClick={() => { setAiMenuOpen(false); extractTasks(); }}
                className="w-full text-left px-3 py-2 hover:bg-slate-100 flex items-center gap-2"
              >
                <ListChecks size={16} /> Aufgaben extrahieren
              </button>
            </div>
          )}
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
        <button
          onClick={() => {
            if (!id) return;
            void upsertTaskLocal({ id: uuid(), title: title || "Aufgabe aus Notiz", note_id: id, status: "todo" });
            toast.success("Aufgabe erstellt");
          }}
          className="p-1 hover:bg-slate-100 rounded"
          title="Aufgabe aus Notiz erstellen"
        >
          <CheckSquare size={18} />
        </button>
        <div className="flex items-center border rounded" role="group" aria-label="Ansicht">
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
        <button
          onClick={() => setHideProps((v) => !v)}
          className={`p-1 rounded ${hideProps ? "bg-slate-200" : "hover:bg-slate-100"}`}
          title={hideProps ? "Farbpalette einblenden" : "Farbpalette ausblenden"}
          aria-pressed={hideProps}
        >
          <Palette size={18} />
        </button>
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
        />        {note.created_at && (
          <span className="text-xs text-slate-400 whitespace-nowrap mr-2" title="Erstellt am">
            {new Date(note.created_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}
          </span>
        )}
        {hasMemo && (
          <Link
            to={`/memos?note_id=${id}`}
            className="flex items-center gap-1 px-2 py-1 mr-1 text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded whitespace-nowrap"
            title="Memos zu dieser Notiz anzeigen"
          >
            <ScrollText size={14} /> Memo
          </Link>
        )}
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
          <div className={`${layout === "split" ? "w-1/2" : "w-full"} ${hideProps ? "excali-hide-props" : ""}`}>
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

      {/* E-Mail-Dialog */}
      {showEmail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowEmail(false)}>
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold">Aktennotiz per E-Mail senden</h2>
              <button onClick={() => setShowEmail(false)} className="p-1 hover:bg-slate-100 rounded">
                <X size={18} />
              </button>
            </div>
            <div className="p-4 space-y-3 overflow-y-auto flex-1">
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
              <div>
                <label className="block text-sm font-medium mb-1">Aktennotiz (Vorschau)</label>
                <textarea
                  className="w-full px-3 py-2 border rounded text-sm font-mono h-48"
                  value={memoText}
                  onChange={(e) => setMemoText(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t">
              <button
                onClick={() => setShowEmail(false)}
                className="px-4 py-2 text-sm border rounded hover:bg-slate-100"
              >
                Abbrechen
              </button>
              <button
                onClick={sendMemoEmail}
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
