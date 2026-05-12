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

export type TaskStatus = "backlog" | "todo" | "doing" | "done";

export type LocalTask = {
  id: string;
  note_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  position: number;
  due_date: string | null; // ISO
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
