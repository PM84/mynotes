import Dexie, { type Table } from "dexie";

export type LocalNote = {
  id: string;
  parent_id: string | null;
  title: string;
  body_md: string | null;
  excalidraw: any | null;
  ocr_text: string | null;
  tags: string[] | null;
  asset_ids?: string[] | null;
  updated_at: string; // ISO
  dirty?: 0 | 1; // unsynced changes
  deleted?: 0 | 1;
};

export type LocalAsset = {
  id: string;
  blob: Blob;
  mime: string;
  filename: string;
  uploaded?: 0 | 1;
  serverSha?: string;
};

export type LocalTask = {
  id: string;
  note_id: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  position: number;
  due_date: string | null; // ISO
  tags: string[] | null;
  closed_at: string | null; // ISO
  updated_at: string; // ISO
  dirty?: 0 | 1;
  deleted?: 0 | 1;
};

export type PendingOp = {
  id?: number;
  type: "note.upsert" | "note.delete" | "asset.upload" | "task.upsert" | "task.delete";
  payload: any;
  created_at: number;
};

class MyNotesDB extends Dexie {
  notes!: Table<LocalNote, string>;
  assets!: Table<LocalAsset, string>;
  pending!: Table<PendingOp, number>;
  tasks!: Table<LocalTask, string>;

  constructor() {
    super("mynotes");
    this.version(1).stores({
      notes: "&id, parent_id, updated_at, dirty, deleted",
      assets: "&id, uploaded",
      pending: "++id, created_at, type",
    });
    this.version(2).stores({
      notes: "&id, parent_id, updated_at, dirty, deleted",
      assets: "&id, uploaded",
      pending: "++id, created_at, type",
      tasks: "&id, status, note_id, updated_at, dirty, deleted",
    });
  }
}

export const db = new MyNotesDB();

const DB_USER_KEY = "mynotes.db_user";

/**
 * Ensures the IndexedDB belongs to the given user. If a different user was
 * previously logged in, clears all tables so data doesn't leak across accounts.
 */
export async function ensureDbUser(userId: string): Promise<void> {
  const prev = localStorage.getItem(DB_USER_KEY);
  if (prev === userId) return;
  // Different user (or first login) → wipe local data
  await db.notes.clear();
  await db.assets.clear();
  await db.pending.clear();
  await db.tasks.clear();
  localStorage.setItem(DB_USER_KEY, userId);
}
