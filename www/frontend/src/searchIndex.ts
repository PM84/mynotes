/**
 * Offline-Volltextsuche via FlexSearch über lokale Dexie-Notes.
 * Index wird im Speicher gehalten; bei jedem Mutationsereignis (Dexie hook)
 * inkrementell aktualisiert. Beim Start einmalig aus IndexedDB hydriert.
 */
import FlexSearch from "flexsearch";
import { db, type LocalNote } from "./db";

type Doc = { id: string; title: string; body: string; ocr: string; tags: string };

const index = new FlexSearch.Document<Doc, true>({
  document: {
    id: "id",
    index: ["title", "body", "ocr", "tags"],
    store: true,
  },
  tokenize: "forward",
  cache: 100,
});

let hydrated = false;

function toDoc(n: LocalNote): Doc {
  return {
    id: n.id,
    title: n.title || "",
    body: n.body_md || "",
    ocr: n.ocr_text || "",
    tags: (n.tags ?? []).join(" "),
  };
}

export async function hydrateSearchIndex() {
  if (hydrated) return;
  const all = await db.notes.toArray();
  for (const n of all) {
    if (!n.deleted) index.add(toDoc(n));
  }
  hydrated = true;
}

// Dexie-Hooks: bei lokalen Änderungen sofort den Index nachziehen.
db.notes.hook("creating", (_pk, obj) => {
  if (!(obj as LocalNote).deleted) index.add(toDoc(obj as LocalNote));
});
db.notes.hook("updating", (mods, pk, obj) => {
  const next = { ...(obj as LocalNote), ...(mods as Partial<LocalNote>) };
  if (next.deleted) {
    index.remove(pk as string);
  } else {
    index.update(toDoc(next));
  }
});
db.notes.hook("deleting", (pk) => {
  index.remove(pk as string);
});

export async function searchLocal(q: string, limit = 20): Promise<LocalNote[]> {
  if (!hydrated) await hydrateSearchIndex();
  if (!q.trim()) return [];
  const raw = index.search(q, { limit, enrich: false });
  // FlexSearch liefert pro Feld ein Result-Array. IDs deduplizieren.
  const ids = new Set<string>();
  for (const field of raw) {
    for (const id of field.result as string[]) ids.add(id);
  }
  const notes: LocalNote[] = [];
  for (const id of ids) {
    const n = await db.notes.get(id);
    if (n && !n.deleted) notes.push(n);
  }
  return notes.slice(0, limit);
}
