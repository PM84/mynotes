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

export async function trySync() {
  if (syncing) return;
  if (!navigator.onLine) { notify(); return; }
  syncing = true;
  notify();
  try {
    while (true) {
      const op = await db.pending.orderBy("id").first();
      if (!op) break;
      try {
        await runOp(op);
        await db.pending.delete(op.id!);
        notify();
      } catch (e) {
        console.warn("sync op failed", op, e);
        // Bei 401/403 abbrechen; sonst nach 5s nochmal
        break;
      }
    }
  } finally {
    syncing = false;
    notify();
  }
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
      n.dirty = 0;
      if (serverOut?.updated_at) n.updated_at = serverOut.updated_at;
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
      t.dirty = 0;
      if (serverOut?.updated_at) t.updated_at = serverOut.updated_at;
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
 * – Aktualisiert lokal vorhandene Notes, wenn Server neuer ist und lokal
 *   nichts dirty ist.
 * – Fügt neue Notes ein.
 * – Löscht lokale Notes, die der Server als deleted_at meldet (oder die
 *   nicht mehr in der Liste auftauchen) – sofern lokal nicht dirty.
 */
export async function pullAll() {
  if (!navigator.onLine) return;
  try {
    const remote = await api<ServerNote[]>("/notes?all=1&include_deleted=1");
    const remoteIds = new Set(remote.map((r) => r.id));
    await db.transaction("rw", db.notes, async () => {
      for (const r of remote) {
        const local = await db.notes.get(r.id);
        const isDeleted = !!r.deleted_at;
        if (isDeleted) {
          if (local && !local.dirty) {
            await db.notes.delete(r.id);
          }
          continue;
        }
        if (!local || (!local.dirty && r.updated_at > local.updated_at)) {
          await db.notes.put({
            id: r.id,
            parent_id: r.parent_id,
            title: r.title,
            body_md: r.body_md,
            excalidraw: r.excalidraw,
            ocr_text: r.ocr_text,
            tags: r.tags,
            updated_at: r.updated_at,
            dirty: 0,
            deleted: 0,
          });
        }
      }
      // Lokale Notes, die der Server gar nicht mehr kennt (weder aktiv noch
      // deleted): bereinigen, sofern nicht dirty.
      const all = await db.notes.toArray();
      for (const local of all) {
        if (!remoteIds.has(local.id) && !local.dirty) {
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
    await db.transaction("rw", db.tasks, async () => {
      for (const r of remote) {
        const local = await db.tasks.get(r.id);
        const isDeleted = !!r.deleted_at;
        if (isDeleted) {
          if (local && !local.dirty) {
            await db.tasks.delete(r.id);
          }
          continue;
        }
        if (!local || (!local.dirty && r.updated_at > local.updated_at)) {
          await db.tasks.put({
            id: r.id,
            note_id: r.note_id,
            title: r.title,
            description: r.description,
            status: r.status as any,
            priority: r.priority,
            position: r.position,
            due_date: r.due_date,
            updated_at: r.updated_at,
            dirty: 0,
            deleted: 0,
          });
        }
      }
      const all = await db.tasks.toArray();
      for (const local of all) {
        if (!remoteIds.has(local.id) && !local.dirty) {
          await db.tasks.delete(local.id);
        }
      }
    });
  } catch (e) {
    console.warn("pull tasks failed", e);
  }
}
