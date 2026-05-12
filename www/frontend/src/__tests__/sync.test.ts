import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db";
import {
  upsertNoteLocal,
  deleteNoteLocal,
  listLocalNotes,
  getLocalNote,
  pendingCount,
} from "../sync";

beforeEach(async () => {
  await db.notes.clear();
  await db.pending.clear();
  await db.assets.clear();
  // navigator.onLine = false → trySync() macht nichts.
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
});

describe("sync local CRUD", () => {
  it("upsertNoteLocal legt Notiz + pending op an", async () => {
    const n = await upsertNoteLocal({ title: "Foo", body_md: "Bar" });
    expect(n.id).toBeTruthy();
    expect(n.dirty).toBe(1);
    const stored = await db.notes.get(n.id);
    expect(stored?.title).toBe("Foo");
    expect(await pendingCount()).toBe(1);
    const op = await db.pending.toArray();
    expect(op[0].type).toBe("note.upsert");
    expect(op[0].payload.data.title).toBe("Foo");
  });

  it("upsertNoteLocal mit existierender id mergt Felder", async () => {
    const a = await upsertNoteLocal({ title: "T1" });
    const b = await upsertNoteLocal({ id: a.id, body_md: "neu" });
    expect(b.id).toBe(a.id);
    expect(b.title).toBe("T1");
    expect(b.body_md).toBe("neu");
  });

  it("deleteNoteLocal markiert deleted=1 und queued op", async () => {
    const n = await upsertNoteLocal({ title: "X" });
    await db.pending.clear(); // upsert-op nicht zählen
    await deleteNoteLocal(n.id);
    const stored = await db.notes.get(n.id);
    expect(stored?.deleted).toBe(1);
    const ops = await db.pending.toArray();
    expect(ops[0].type).toBe("note.delete");
  });

  it("listLocalNotes filtert deleted und sortiert nach updated_at desc", async () => {
    const a = await upsertNoteLocal({ title: "A" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await upsertNoteLocal({ title: "B" });
    await deleteNoteLocal(a.id);
    const list = await listLocalNotes(null);
    expect(list.map((n) => n.id)).toEqual([b.id]);
  });

  it("getLocalNote liefert Notiz", async () => {
    const n = await upsertNoteLocal({ title: "G" });
    const got = await getLocalNote(n.id);
    expect(got?.title).toBe("G");
  });

  it("excalidraw-Daten bleiben dirty solange weitere Ops ausstehen", async () => {
    // Szenario: Notiz offline anlegen, dann Excalidraw-Daten speichern
    // → 2 pending Ops. Nach Op1 muss dirty=1 bleiben (Op2 steht noch aus).
    const n = await upsertNoteLocal({ title: "Zeichnung" });
    const excaliData = { elements: [{ type: "freedraw" }], appState: {}, files: null };
    await upsertNoteLocal({ id: n.id, excalidraw: excaliData });
    expect(await pendingCount()).toBe(2);

    // Prüfe: Notiz hat Excalidraw-Daten und ist dirty
    const before = await db.notes.get(n.id);
    expect(before?.excalidraw).toEqual(excaliData);
    expect(before?.dirty).toBe(1);
  });
});
