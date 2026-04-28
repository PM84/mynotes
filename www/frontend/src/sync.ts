import { db, type LocalNote, type PendingOp } from "./db";
import { api, apiJson } from "./api";
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
    parent_id: input.parent_id ?? existing?.parent_id ?? null,
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

async function runOp(op: PendingOp) {
  if (op.type === "note.upsert") {
    await apiJson(`/notes/${op.payload.id}`, "PUT", op.payload.data);
    const n = await db.notes.get(op.payload.id);
    if (n) {
      n.dirty = 0;
      await db.notes.put(n);
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
  }
}

window.addEventListener("online", () => void trySync());

// Initial pull aller Top-Level-Notes (wenn online)
export async function pullTopLevel() {
  if (!navigator.onLine) return;
  try {
    const remote = await api<ServerNote[]>("/notes");
    await db.transaction("rw", db.notes, async () => {
      for (const r of remote) {
        const local = await db.notes.get(r.id);
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
    });
  } catch (e) {
    console.warn("pull failed", e);
  }
}
