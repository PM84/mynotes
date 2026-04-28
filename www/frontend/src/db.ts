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

export type PendingOp = {
  id?: number;
  type: "note.upsert" | "note.delete" | "asset.upload";
  payload: any;
  created_at: number;
};

class MyNotesDB extends Dexie {
  notes!: Table<LocalNote, string>;
  assets!: Table<LocalAsset, string>;
  pending!: Table<PendingOp, number>;

  constructor() {
    super("mynotes");
    this.version(1).stores({
      notes: "&id, parent_id, updated_at, dirty, deleted",
      assets: "&id, uploaded",
      pending: "++id, created_at, type",
    });
  }
}

export const db = new MyNotesDB();
