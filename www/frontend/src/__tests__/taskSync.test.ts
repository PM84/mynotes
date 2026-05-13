import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db";
import {
  upsertTaskLocal,
  deleteTaskLocal,
  listLocalTasks,
  getLocalTask,
  pendingCount,
} from "../sync";

beforeEach(async () => {
  await db.tasks.clear();
  await db.pending.clear();
  Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
});

describe("task local CRUD", () => {
  it("upsertTaskLocal legt Task + pending op an", async () => {
    const t = await upsertTaskLocal({ title: "Bug fixen", status: "todo" });
    expect(t.id).toBeTruthy();
    expect(t.dirty).toBe(1);
    expect(t.status).toBe("todo");
    const stored = await db.tasks.get(t.id);
    expect(stored?.title).toBe("Bug fixen");
    expect(await pendingCount()).toBe(1);
    const ops = await db.pending.toArray();
    expect(ops[0].type).toBe("task.upsert");
    expect(ops[0].payload.data.title).toBe("Bug fixen");
  });

  it("upsertTaskLocal mit existierender id mergt Felder", async () => {
    const a = await upsertTaskLocal({ title: "T1", status: "backlog" });
    const b = await upsertTaskLocal({ id: a.id, status: "doing" });
    expect(b.id).toBe(a.id);
    expect(b.title).toBe("T1");
    expect(b.status).toBe("doing");
  });

  it("deleteTaskLocal markiert deleted=1 und queued op", async () => {
    const t = await upsertTaskLocal({ title: "X", status: "backlog" });
    await db.pending.clear();
    await deleteTaskLocal(t.id);
    const stored = await db.tasks.get(t.id);
    expect(stored?.deleted).toBe(1);
    const ops = await db.pending.toArray();
    expect(ops[0].type).toBe("task.delete");
  });

  it("listLocalTasks filtert deleted und sortiert nach position", async () => {
    const a = await upsertTaskLocal({ title: "A", status: "backlog", position: 1 });
    const b = await upsertTaskLocal({ title: "B", status: "backlog", position: 0 });
    await deleteTaskLocal(a.id);
    const list = await listLocalTasks();
    expect(list.map((t) => t.id)).toEqual([b.id]);
  });

  it("getLocalTask liefert Task", async () => {
    const t = await upsertTaskLocal({ title: "G", status: "todo" });
    const got = await getLocalTask(t.id);
    expect(got?.title).toBe("G");
  });

  it("upsertTaskLocal setzt note_id korrekt", async () => {
    const noteId = "note-123";
    const t = await upsertTaskLocal({ title: "Aus Notiz", status: "todo", note_id: noteId });
    expect(t.note_id).toBe(noteId);
    const stored = await db.tasks.get(t.id);
    expect(stored?.note_id).toBe(noteId);
  });

  it("upsertTaskLocal speichert Tags korrekt", async () => {
    const t = await upsertTaskLocal({ title: "Mit Tags", status: "todo", tags: ["bug", "prio"] });
    expect(t.tags).toEqual(["bug", "prio"]);
    const stored = await db.tasks.get(t.id);
    expect(stored?.tags).toEqual(["bug", "prio"]);
    // Tags in pending op
    const ops = await db.pending.toArray();
    expect(ops[0].payload.data.tags).toEqual(["bug", "prio"]);
  });

  it("upsertTaskLocal fügt Tags nachträglich hinzu", async () => {
    const a = await upsertTaskLocal({ title: "Ohne Tags", status: "backlog" });
    expect(a.tags).toBeNull();

    const b = await upsertTaskLocal({ id: a.id, tags: ["urgent"] });
    expect(b.tags).toEqual(["urgent"]);
    const stored = await db.tasks.get(a.id);
    expect(stored?.tags).toEqual(["urgent"]);
  });

  it("upsertTaskLocal löscht Tags mit null", async () => {
    const a = await upsertTaskLocal({ title: "T", status: "todo", tags: ["a", "b"] });
    expect(a.tags).toEqual(["a", "b"]);

    const b = await upsertTaskLocal({ id: a.id, tags: null });
    expect(b.tags).toBeNull();
    const stored = await db.tasks.get(a.id);
    expect(stored?.tags).toBeNull();
  });

  it("upsertTaskLocal behält Tags bei wenn nicht angegeben", async () => {
    const a = await upsertTaskLocal({ title: "T", status: "todo", tags: ["keep"] });
    // Update ohne tags → bestehende Tags bleiben
    const b = await upsertTaskLocal({ id: a.id, title: "Neu" });
    expect(b.tags).toEqual(["keep"]);
  });
});
