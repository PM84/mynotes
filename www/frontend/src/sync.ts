import { db, type LocalNote, type LocalTask, type PendingOp } from "./db";
import { api, apiJson, ApiError } from "./api";
import { v4 as uuid } from "uuid";

export type ServerNote = {
  id: string;
  parent_id: string | null;
  title: string;
  body_md: string | null;
  excalidraw: any | null;
  ocr_text: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
};

export type ServerTask = {
  id: string;
  note_id: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  position: number;
  due_date: string | null;
  tags: string[] | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
};

const now = () => new Date().toISOString();

// ---------- Local CRUD (offline-first) ----------

export async function listLocalNotes(parent_id: string | null = null) {
  const all = await db.notes.toArray();
  return all
    .filter((n) => !n.deleted && (n.parent_id ?? null) === parent_id)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function getLocalNote(id: string) {
  return db.notes.get(id);
}

export async function upsertNoteLocal(input: Partial<LocalNote> & { id?: string }) {
  const id = input.id ?? uuid();
  const existing = await db.notes.get(id);
  const next: LocalNote = {
    id,
    parent_id: "parent_id" in input ? (input.parent_id ?? null) : (existing?.parent_id ?? null),
    title: input.title ?? existing?.title ?? "",
    body_md: input.body_md ?? existing?.body_md ?? null,
    excalidraw: input.excalidraw ?? existing?.excalidraw ?? null,
    ocr_text: existing?.ocr_text ?? null,
    tags: input.tags ?? existing?.tags ?? null,
    asset_ids: input.asset_ids ?? existing?.asset_ids ?? null,
    created_at: existing?.created_at,
    updated_at: now(),
    dirty: 1,
    deleted: 0,
  };
  await db.notes.put(next);
  // Basisversion zum Zeitpunkt des Edits = vorherige updated_at (existing).
  // Damit erkennt der Server, ob in der Zwischenzeit ein anderes Gerät gepusht hat.
  const baseUpdatedAt = existing?.updated_at ?? null;
  await db.pending.add({
    type: "note.upsert",
    payload: {
      id,
      data: {
        id,
        parent_id: next.parent_id,
        title: next.title,
        body_md: next.body_md,
        excalidraw: next.excalidraw,
        tags: next.tags,
        asset_ids: next.asset_ids,
        client_updated_at: baseUpdatedAt,
      },
    },
    created_at: Date.now(),
  });
  void trySync();
  return next;
}

export async function deleteNoteLocal(id: string) {
  const n = await db.notes.get(id);
  if (!n) return;
  n.deleted = 1;
  n.updated_at = now();
  n.dirty = 1;
  await db.notes.put(n);
  await db.pending.add({ type: "note.delete", payload: { id }, created_at: Date.now() });
  void trySync();
}

/** Liefert alle direkten Kinder einer Notiz (nicht gelöscht). */
export async function getChildren(parentId: string) {
  const all = await db.notes.toArray();
  return all.filter((n) => !n.deleted && n.parent_id === parentId);
}

/** Löscht eine Notiz und rekursiv alle Unternotizen. */
export async function deleteNoteRecursive(id: string) {
  const children = await getChildren(id);
  for (const child of children) {
    await deleteNoteRecursive(child.id);
  }
  await deleteNoteLocal(id);
}

/** Schiebt alle Kinder einer Notiz eine Ebene höher (zum parent des Eltern-Knotens). */
export async function reparentChildren(id: string) {
  const n = await db.notes.get(id);
  const newParent = n?.parent_id ?? null;
  const children = await getChildren(id);
  for (const child of children) {
    await upsertNoteLocal({ id: child.id, parent_id: newParent });
  }
}

// ---------- Asset offline storage ----------

export async function storeAssetLocal(file: File): Promise<string> {
  const id = uuid();
  await db.assets.put({ id, blob: file, mime: file.type, filename: file.name, uploaded: 0 });
  await db.pending.add({
    type: "asset.upload",
    payload: { id, filename: file.name },
    created_at: Date.now(),
  });
  void trySync();
  return id;
}

// ---------- Task local CRUD ----------

export async function listLocalTasks() {
  const all = await db.tasks.toArray();
  return all.filter((t) => !t.deleted).sort((a, b) => a.position - b.position);
}

export async function getLocalTask(id: string) {
  return db.tasks.get(id);
}

export async function upsertTaskLocal(input: Partial<LocalTask> & { id?: string }) {
  const id = input.id ?? uuid();
  const existing = await db.tasks.get(id);
  const next: LocalTask = {
    id,
    note_id: input.note_id !== undefined ? (input.note_id ?? null) : (existing?.note_id ?? null),
    title: input.title ?? existing?.title ?? "",
    description: input.description !== undefined ? input.description : (existing?.description ?? null),
    status: input.status ?? existing?.status ?? "backlog",
    priority: input.priority ?? existing?.priority ?? 0,
    position: input.position ?? existing?.position ?? 0,
    due_date: input.due_date !== undefined ? input.due_date : (existing?.due_date ?? null),
    tags: input.tags !== undefined ? input.tags : (existing?.tags ?? null),
    closed_at: input.closed_at !== undefined ? input.closed_at : (existing?.closed_at ?? null),
    updated_at: now(),
    dirty: 1,
    deleted: 0,
  };
  await db.tasks.put(next);
  const baseUpdatedAt = existing?.updated_at ?? null;
  await db.pending.add({
    type: "task.upsert",
    payload: {
      id,
      data: {
        id,
        note_id: next.note_id,
        title: next.title,
        description: next.description,
        status: next.status,
        priority: next.priority,
        position: next.position,
        due_date: next.due_date,
        tags: next.tags,
        closed_at: next.closed_at,
        client_updated_at: baseUpdatedAt,
      },
    },
    created_at: Date.now(),
  });
  void trySync();
  return next;
}

export async function deleteTaskLocal(id: string) {
  const t = await db.tasks.get(id);
  if (!t) return;
  t.deleted = 1;
  t.updated_at = now();
  t.dirty = 1;
  await db.tasks.put(t);
  await db.pending.add({ type: "task.delete", payload: { id }, created_at: Date.now() });
  void trySync();
}

// ---------- Sync engine ----------

let syncing = false;
const subs = new Set<() => void>();
export function onSyncChange(fn: () => void) {
  subs.add(fn);
  return () => subs.delete(fn);
}
function notify() { subs.forEach((f) => f()); }

export async function pendingCount() {
  return db.pending.count();
}

// ---------- Batch sync ----------

type BatchResult = {
  ok?: boolean;
  id?: string;
  error?: string;
  conflict?: boolean;
  server?: any;
  data?: any;
};

const BATCH_SIZE = 50;

/**
 * Dedupliziert Pending-Ops für effizienteren Batch-Sync:
 * - Mehrere Upserts für dieselbe Entität → letzten Datenstand + erstes
 *   client_updated_at behalten
 * - Delete nach Upsert(s) → nur Delete senden
 */
function deduplicateOps(ops: PendingOp[]): {
  ops: PendingOp[];
  consumedIds: Map<PendingOp, number[]>;
} {
  const groups = new Map<string, PendingOp[]>();
  for (const op of ops) {
    const entityType = op.type.startsWith("note.") ? "note" : "task";
    const key = `${entityType}:${op.payload.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(op);
  }
  const result: PendingOp[] = [];
  const consumedIds = new Map<PendingOp, number[]>();
  for (const [, entityOps] of groups) {
    const allIds = entityOps.map((o) => o.id!);
    const last = entityOps[entityOps.length - 1];
    if (last.type.endsWith(".delete")) {
      // Delete ist die finale Aktion – alle Upserts davor ignorieren
      result.push(last);
      consumedIds.set(last, allIds);
    } else {
      const upserts = entityOps.filter((o) => o.type.endsWith(".upsert"));
      if (upserts.length > 1) {
        // Merge: letzter Datenstand + erstes client_updated_at (Server-Baseline)
        const merged: PendingOp = {
          ...last,
          payload: {
            ...last.payload,
            data: {
              ...last.payload.data,
              client_updated_at: upserts[0].payload?.data?.client_updated_at,
            },
          },
        };
        result.push(merged);
        consumedIds.set(merged, allIds);
      } else {
        result.push(last);
        consumedIds.set(last, allIds);
      }
    }
  }
  return { ops: result, consumedIds };
}

export async function trySync() {
  if (syncing) return;
  if (!navigator.onLine) { notify(); return; }
  syncing = true;
  notify();
  try {
    // 1. Asset-Uploads einzeln verarbeiten (FormData, kein Batch möglich)
    while (true) {
      const op = await db.pending.where("type").equals("asset.upload").first();
      if (!op) break;
      try {
        await runOp(op);
        await db.pending.delete(op.id!);
        notify();
      } catch (e) {
        console.warn("asset upload failed", op, e);
        break;
      }
    }
    // 2. Verbleibende Ops (Notes + Tasks) sammeln und deduplizieren
    const allOps = (await db.pending.orderBy("id").toArray()).filter(
      (op) => op.type !== "asset.upload",
    );
    if (!allOps.length) return;
    const { ops: deduped, consumedIds } = deduplicateOps(allOps);
    // 3. In Batches an /sync/batch senden
    for (let i = 0; i < deduped.length; i += BATCH_SIZE) {
      const batch = deduped.slice(i, i + BATCH_SIZE);
      const payload = batch.map((op) => ({
        type: op.type,
        id: op.payload.id,
        data: op.payload.data,
      }));
      let results: BatchResult[];
      try {
        const res = await apiJson<{ results: BatchResult[] }>("/sync/batch", "POST", payload);
        results = res.results;
      } catch (e) {
        console.warn("batch sync failed", e);
        break;
      }
      // 4. Ergebnisse verarbeiten
      for (let j = 0; j < batch.length; j++) {
        const op = batch[j];
        const r = results?.[j];
        if (!r) continue;
        const ids = consumedIds.get(op) || [op.id!];
        if (r.conflict && r.server) {
          // Konflikt – Server gewinnt
          if (op.type === "note.upsert") {
            const s = r.server as ServerNote;
            await db.notes.put({
              id: s.id, parent_id: s.parent_id, title: s.title,
              body_md: s.body_md, excalidraw: s.excalidraw,
              ocr_text: s.ocr_text, tags: s.tags,
              created_at: s.created_at,
              updated_at: s.updated_at, dirty: 0,
              deleted: s.deleted_at ? 1 : 0,
            });
            conflictHandler?.(s.id, s);
          } else if (op.type === "task.upsert") {
            const s = r.server as ServerTask;
            await db.tasks.put({
              id: s.id, note_id: s.note_id, title: s.title,
              description: s.description, status: s.status as any,
              priority: s.priority, position: s.position,
              due_date: s.due_date, tags: s.tags, closed_at: s.closed_at,
              updated_at: s.updated_at,
              dirty: 0, deleted: s.deleted_at ? 1 : 0,
            });
          }
          for (const id of ids) await db.pending.delete(id);
        } else if (r.ok) {
          // Erfolg – Pending-Ops entfernen, dirty bleibt 1.
          // pullAll wird dirty auf 0 setzen, sobald der Server die Daten
          // bestätigt hat. So gibt es keine Race-Condition zwischen
          // trySync und pullAll, die zum Löschen der Notiz führen könnte.
          for (const id of ids) await db.pending.delete(id);
          if (op.type === "note.upsert" && r.data) {
            const n = await db.notes.get(op.payload.id);
            if (n) {
              if (r.data.created_at) n.created_at = r.data.created_at;
              if (r.data.updated_at) n.updated_at = r.data.updated_at;
              // dirty bleibt 1 – pullAll klärt das
              await db.notes.put(n);
            }
          } else if (op.type === "task.upsert" && r.data) {
            const t = await db.tasks.get(op.payload.id);
            if (t) {
              if (r.data.updated_at) t.updated_at = r.data.updated_at;
              // dirty bleibt 1 – pullAll klärt das
              await db.tasks.put(t);
            }
          } else if (op.type === "note.delete") {
            await db.notes.delete(op.payload.id);
          } else if (op.type === "task.delete") {
            await db.tasks.delete(op.payload.id);
          }
        }
        // Bei r.error (kein Konflikt): Ops bleiben in pending für Retry
      }
      notify();
    }
  } finally {
    syncing = false;
    notify();
  }
  // Nach erfolgreichem Push: Pull starten, damit pullAll die dirty-Flags
  // auf 0 setzen kann und der Server-Zustand konsistent übernommen wird.
  void pullAll();
}

let conflictHandler: ((id: string, server: ServerNote) => void) | null = null;
export function onConflict(fn: (id: string, server: ServerNote) => void) {
  conflictHandler = fn;
}

async function runOp(op: PendingOp) {
  if (op.type === "note.upsert") {
    let serverOut: ServerNote | undefined;
    try {
      serverOut = await apiJson<ServerNote>(`/notes/${op.payload.id}`, "PUT", op.payload.data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Server hat eine neuere Version. Strategie: Server-wins. Lokale
        // Änderungen werden durch die Server-Variante ersetzt; der User
        // bekommt einen Hinweis (per Handler). Anschließend Op droppen,
        // damit der Push nicht endlos wiederholt wird.
        const body = (e.body as any) ?? {};
        const server: ServerNote | undefined = body?.detail?.server;
        if (server) {
          await db.notes.put({
            id: server.id,
            parent_id: server.parent_id,
            title: server.title,
            body_md: server.body_md,
            excalidraw: server.excalidraw,
            ocr_text: server.ocr_text,
            tags: server.tags,
            created_at: server.created_at,
            updated_at: server.updated_at,
            dirty: 0,
            deleted: server.deleted_at ? 1 : 0,
          });
          conflictHandler?.(server.id, server);
        }
        return;
      }
      throw e;
    }
    const n = await db.notes.get(op.payload.id);
    if (n) {
      if (serverOut?.created_at) n.created_at = serverOut.created_at;
      if (serverOut?.updated_at) n.updated_at = serverOut.updated_at;
      // dirty bleibt 1 – pullAll klärt das, sobald der Server die Daten
      // bestätigt (verhindert Race-Condition mit parallelem pullAll).
      await db.notes.put(n);
    }
    // Nach erfolgreichem Push: client_updated_at in allen verbleibenden
    // Pending-Ops für dieselbe Notiz auf den Server-Timestamp aktualisieren,
    // damit die Optimistic-Locking-Prüfung beim nächsten Push keinen
    // falschen 409-Conflict auslöst.
    if (serverOut?.updated_at) {
      const pendingOps = await db.pending.toArray();
      for (const p of pendingOps) {
        if (p.type === "note.upsert" && p.payload?.id === op.payload.id) {
          p.payload.data.client_updated_at = serverOut.updated_at;
          await db.pending.put(p);
        }
      }
    }
  } else if (op.type === "note.delete") {
    await apiJson(`/notes/${op.payload.id}`, "DELETE");
    await db.notes.delete(op.payload.id);
  } else if (op.type === "asset.upload") {
    const local = await db.assets.get(op.payload.id);
    if (!local) return;
    const fd = new FormData();
    fd.append("file", local.blob, local.filename);
    const res = await api<{ id: string; sha256: string }>(`/assets`, { method: "POST", body: fd });
    // Server vergibt eigene UUID. Lokale Asset-ID + alle Note-Referenzen umschreiben.
    if (res.id !== local.id) {
      const oldId = local.id;
      await db.transaction("rw", db.assets, db.notes, db.pending, async () => {
        await db.assets.delete(oldId);
        await db.assets.put({ ...local, id: res.id, uploaded: 1, serverSha: res.sha256 });
        const notesWithAsset = await db.notes
          .filter((n) => (n.asset_ids ?? []).includes(oldId))
          .toArray();
        for (const n of notesWithAsset) {
          n.asset_ids = (n.asset_ids ?? []).map((a) => (a === oldId ? res.id : a));
          await db.notes.put(n);
        }
        // Auch bereits eingereihte note.upsert-Ops umschreiben, damit sie
        // beim Senden keinen FK-Fehler auf assets.id auslösen.
        const pendingOps = await db.pending.toArray();
        for (const p of pendingOps) {
          if (p.type !== "note.upsert") continue;
          const ids: string[] | null | undefined = p.payload?.data?.asset_ids;
          if (!ids || !ids.includes(oldId)) continue;
          p.payload.data.asset_ids = ids.map((a) => (a === oldId ? res.id : a));
          await db.pending.put(p);
        }
      });
    } else {
      local.uploaded = 1;
      local.serverSha = res.sha256;
      await db.assets.put(local);
    }
  } else if (op.type === "task.upsert") {
    let serverOut: ServerTask | undefined;
    try {
      serverOut = await apiJson<ServerTask>(`/tasks/${op.payload.id}`, "PUT", op.payload.data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = (e.body as any) ?? {};
        const server: ServerTask | undefined = body?.detail?.server;
        if (server) {
          await db.tasks.put({
            id: server.id,
            note_id: server.note_id,
            title: server.title,
            description: server.description,
            status: server.status as any,
            priority: server.priority,
            position: server.position,
            due_date: server.due_date,
            tags: server.tags,
            closed_at: server.closed_at,
            updated_at: server.updated_at,
            dirty: 0,
            deleted: server.deleted_at ? 1 : 0,
          });
        }
        return;
      }
      throw e;
    }
    const t = await db.tasks.get(op.payload.id);
    if (t) {
      if (serverOut?.updated_at) t.updated_at = serverOut.updated_at;
      // dirty bleibt 1 – pullAll klärt das.
      await db.tasks.put(t);
    }
    if (serverOut?.updated_at) {
      const pendingOps = await db.pending.toArray();
      for (const p of pendingOps) {
        if (p.type === "task.upsert" && p.payload?.id === op.payload.id) {
          p.payload.data.client_updated_at = serverOut.updated_at;
          await db.pending.put(p);
        }
      }
    }
  } else if (op.type === "task.delete") {
    await apiJson(`/tasks/${op.payload.id}`, "DELETE");
    await db.tasks.delete(op.payload.id);
  }
}

window.addEventListener("online", () => void trySync());

// Backwards-Compat-Alias.
export const pullTopLevel = pullAll;

/**
 * Vollständiger Pull (rekursiv, inkl. Tombstones).
 * Throttled: läuft höchstens einmal alle 2 s, parallele Aufrufe werden
 * zusammengefasst (einer wird nachgeholt sobald der aktive fertig ist).
 */
let _pulling = false;
let _pullQueued = false;
const PULL_THROTTLE_MS = 2000;
let _lastPull = 0;

export async function pullAll() {
  const now = Date.now();
  if (_pulling || now - _lastPull < PULL_THROTTLE_MS) {
    _pullQueued = true;
    return;
  }
  _pulling = true;
  _lastPull = now;
  try {
    await _pullAllImpl();
  } finally {
    _pulling = false;
    if (_pullQueued) {
      _pullQueued = false;
      // Nächsten Pull frühestens nach Ablauf der Throttle-Sperre starten.
      const wait = PULL_THROTTLE_MS - (Date.now() - _lastPull);
      if (wait > 0) {
        setTimeout(() => void pullAll(), wait);
      } else {
        void pullAll();
      }
    }
  }
}

/**
 * Interne Implementierung – wird von pullAll() throttled aufgerufen.
 * – Aktualisiert lokal vorhandene Notes, wenn Server neuer ist und lokal
 *   nichts dirty ist.
 * – Fügt neue Notes ein.
 * – Löscht lokale Notes, die der Server als deleted_at meldet (oder die
 *   nicht mehr in der Liste auftauchen) – sofern lokal nicht dirty.
 */
async function _pullAllImpl() {
  if (!navigator.onLine) return;
  try {
    const remote = await api<ServerNote[]>("/notes?all=1&include_deleted=1");
    const remoteIds = new Set(remote.map((r) => r.id));
    await db.transaction("rw", db.notes, db.pending, async () => {
      for (const r of remote) {
        const local = await db.notes.get(r.id);
        const isDeleted = !!r.deleted_at;
        if (isDeleted) {
          if (local && !local.dirty) {
            await db.notes.delete(r.id);
          }
          continue;
        }
        if (!local) {
          await db.notes.put({
            id: r.id,
            parent_id: r.parent_id,
            title: r.title,
            body_md: r.body_md,
            excalidraw: r.excalidraw,
            ocr_text: r.ocr_text,
            tags: r.tags,
            created_at: r.created_at,
            updated_at: r.updated_at,
            dirty: 0,
            deleted: 0,
          });
        } else if (local.dirty) {
          // Lokal dirty – prüfen ob noch Pending-Ops existieren.
          // Wenn nicht, wurde der Push erfolgreich abgeschlossen und wir
          // können den Server-Stand übernehmen und dirty auf 0 setzen.
          const hasPending = await db.pending
            .filter((p) => (p.type === "note.upsert" || p.type === "note.delete") && p.payload?.id === r.id)
            .count() > 0;
          if (!hasPending) {
            await db.notes.put({
              id: r.id,
              parent_id: r.parent_id,
              title: r.title,
              body_md: r.body_md,
              excalidraw: r.excalidraw,
              ocr_text: r.ocr_text,
              tags: r.tags,
              created_at: r.created_at,
              updated_at: r.updated_at,
              dirty: 0,
              deleted: 0,
            });
          }
        } else if (r.updated_at > local.updated_at) {
          await db.notes.put({
            id: r.id,
            parent_id: r.parent_id,
            title: r.title,
            body_md: r.body_md,
            excalidraw: r.excalidraw,
            ocr_text: r.ocr_text,
            tags: r.tags,
            created_at: r.created_at,
            updated_at: r.updated_at,
            dirty: 0,
            deleted: 0,
          });
        }
      }
      // Lokale Notes, die der Server gar nicht mehr kennt (weder aktiv noch
      // deleted): bereinigen, sofern nicht dirty und keine Pending-Ops.
      const pendingNoteIds = new Set(
        (await db.pending.toArray())
          .filter((p) => p.type.startsWith("note."))
          .map((p) => p.payload?.id)
          .filter(Boolean),
      );
      const all = await db.notes.toArray();
      for (const local of all) {
        if (!remoteIds.has(local.id) && !local.dirty && !pendingNoteIds.has(local.id)) {
          await db.notes.delete(local.id);
        }
      }
    });
    // Pull tasks
    await pullTasks();
    notify();
  } catch (e) {
    console.warn("pull failed", e);
  }
}

async function pullTasks() {
  try {
    const remote = await api<ServerTask[]>("/tasks?include_deleted=1");
    const remoteIds = new Set(remote.map((r) => r.id));
    await db.transaction("rw", db.tasks, db.pending, async () => {
      for (const r of remote) {
        const local = await db.tasks.get(r.id);
        const isDeleted = !!r.deleted_at;
        if (isDeleted) {
          if (local && !local.dirty) {
            await db.tasks.delete(r.id);
          }
          continue;
        }
        if (!local) {
          await db.tasks.put({
            id: r.id,
            note_id: r.note_id,
            title: r.title,
            description: r.description,
            status: r.status as any,
            priority: r.priority,
            position: r.position,
            due_date: r.due_date,
            tags: r.tags ?? null,
            closed_at: r.closed_at ?? null,
            updated_at: r.updated_at,
            dirty: 0,
            deleted: 0,
          });
        } else if (local.dirty) {
          const hasPending = await db.pending
            .filter((p) => (p.type === "task.upsert" || p.type === "task.delete") && p.payload?.id === r.id)
            .count() > 0;
          if (!hasPending) {
            await db.tasks.put({
              id: r.id,
              note_id: r.note_id,
              title: r.title,
              description: r.description,
              status: r.status as any,
              priority: r.priority,
              position: r.position,
              due_date: r.due_date,
              tags: r.tags ?? null,
              closed_at: r.closed_at ?? null,
              updated_at: r.updated_at,
              dirty: 0,
              deleted: 0,
            });
          }
        } else if (r.updated_at > local.updated_at) {
          await db.tasks.put({
            id: r.id,
            note_id: r.note_id,
            title: r.title,
            description: r.description,
            status: r.status as any,
            priority: r.priority,
            position: r.position,
            due_date: r.due_date,
            tags: r.tags ?? null,
            closed_at: r.closed_at ?? null,
            updated_at: r.updated_at,
            dirty: 0,
            deleted: 0,
          });
        }
      }
      const pendingTaskIds = new Set(
        (await db.pending.toArray())
          .filter((p) => p.type.startsWith("task."))
          .map((p) => p.payload?.id)
          .filter(Boolean),
      );
      const all = await db.tasks.toArray();
      for (const local of all) {
        if (!remoteIds.has(local.id) && !local.dirty && !pendingTaskIds.has(local.id)) {
          await db.tasks.delete(local.id);
        }
      }
    });
  } catch (e) {
    console.warn("pull tasks failed", e);
  }
}
