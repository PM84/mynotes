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
});
