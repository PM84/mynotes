import { describe, it, expect, beforeEach } from "vitest";
import { db } from "../db";
import { searchLocal, hydrateSearchIndex } from "../searchIndex";

beforeEach(async () => {
  await db.notes.clear();
});

describe("searchLocal", () => {
  it("findet Notizen über title und body", async () => {
    await db.notes.bulkPut([
      {
        id: "1",
        parent_id: null,
        title: "Python Tutorial",
        body_md: "asyncio coroutines",
        excalidraw: null,
        ocr_text: null,
        tags: ["python"],
        updated_at: new Date().toISOString(),
      },
      {
        id: "2",
        parent_id: null,
        title: "Kochrezept",
        body_md: "Tomaten",
        excalidraw: null,
        ocr_text: null,
        tags: null,
        updated_at: new Date().toISOString(),
      },
    ]);
    await hydrateSearchIndex();
    const hits = await searchLocal("asyncio");
    expect(hits.map((n) => n.id)).toContain("1");
    expect(hits.map((n) => n.id)).not.toContain("2");
  });

  it("ignoriert gelöschte Notizen", async () => {
    await db.notes.put({
      id: "del",
      parent_id: null,
      title: "geheim",
      body_md: "",
      excalidraw: null,
      ocr_text: null,
      tags: null,
      deleted: 1,
      updated_at: new Date().toISOString(),
    });
    await hydrateSearchIndex();
    const hits = await searchLocal("geheim");
    expect(hits).toEqual([]);
  });

  it("liefert leere Liste bei leerer Query", async () => {
    expect(await searchLocal("")).toEqual([]);
  });
});
