import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { DragDropContext, Droppable, Draggable, type DropResult, type DraggableProvidedDragHandleProps } from "@hello-pangea/dnd";
import { type LocalTask } from "../db";
import { upsertTaskLocal, deleteTaskLocal, listLocalTasks } from "../sync";
import { api } from "../api";
import { Plus, Trash2, Link as LinkIcon, GripVertical, X, Eye, EyeOff, Settings2, Pencil, Check, GripHorizontal } from "lucide-react";
import { Link } from "react-router-dom";
import { v4 as uuid } from "uuid";

type KanbanColumn = { id: string; title: string; color: string; done?: boolean };

const FALLBACK_COLUMNS: KanbanColumn[] = [
  { id: "backlog", title: "Backlog", color: "bg-slate-100" },
  { id: "todo", title: "To Do", color: "bg-blue-50" },
  { id: "doing", title: "In Arbeit", color: "bg-amber-50" },
  { id: "done", title: "Erledigt", color: "bg-emerald-50", done: true },
];

const COLUMN_COLORS = [
  "bg-slate-100", "bg-blue-50", "bg-amber-50", "bg-emerald-50",
  "bg-rose-50", "bg-purple-50", "bg-cyan-50", "bg-orange-50",
];

export function Tasks() {
  const allTasks = useLiveQuery(() => listLocalTasks(), [], []);
  const [columns, setColumns] = useState<KanbanColumn[]>(FALLBACK_COLUMNS);
  const [showClosed, setShowClosed] = useState(false);
  const [editingColumns, setEditingColumns] = useState(false);

  // Fetch columns from API
  useEffect(() => {
    api<KanbanColumn[]>("/tasks/columns")
      .then((cols) => { if (cols.length) setColumns(cols); })
      .catch(() => {});
  }, []);

  const saveColumns = useCallback(async (cols: KanbanColumn[]) => {
    setColumns(cols);
    try { await api("/tasks/columns", { method: "PUT", body: JSON.stringify(cols) }); } catch {}
  }, []);

  // Collect all tags for autocomplete
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of allTasks) {
      for (const tag of t.tags ?? []) set.add(tag);
    }
    return [...set].sort();
  }, [allTasks]);

  const groupedTasks = useMemo(() => {
    const map: Record<string, LocalTask[]> = {};
    for (const col of columns) map[col.id] = [];
    for (const t of allTasks) {
      if (!showClosed && t.closed_at) continue;
      const bucket = map[t.status] ?? map[columns[0]?.id];
      if (bucket) bucket.push(t);
    }
    for (const col of Object.values(map)) {
      col.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [allTasks, columns, showClosed]);

  const closedCount = useMemo(() => allTasks.filter((t) => t.closed_at).length, [allTasks]);

  const onDragEnd = useCallback(
    (result: DropResult) => {
      const { source, destination, type } = result;
      if (!destination) return;
      if (source.droppableId === destination.droppableId && source.index === destination.index) return;

      // Column reorder
      if (type === "COLUMN") {
        const reordered = [...columns];
        const [moved] = reordered.splice(source.index, 1);
        reordered.splice(destination.index, 0, moved);
        void saveColumns(reordered);
        return;
      }

      const srcCol = source.droppableId;
      const dstCol = destination.droppableId;
      const srcItems = [...(groupedTasks[srcCol] ?? [])];
      const [moved] = srcItems.splice(source.index, 1);
      if (!moved) return;

      // Determine if moving to a done column
      const dstColDef = columns.find((c) => c.id === dstCol);
      const srcColDef = columns.find((c) => c.id === srcCol);
      const extraFields: Partial<LocalTask> = {};
      if (dstColDef?.done && !srcColDef?.done) {
        // Don't auto-close on drag, but field is present for worker
      }
      if (!dstColDef?.done && srcColDef?.done && moved.closed_at) {
        extraFields.closed_at = null;
      }

      if (srcCol === dstCol) {
        srcItems.splice(destination.index, 0, moved);
        for (let i = 0; i < srcItems.length; i++) {
          if (srcItems[i].position !== i || srcItems[i].id === moved.id) {
            void upsertTaskLocal({ id: srcItems[i].id, position: i, status: dstCol, ...extraFields });
          }
        }
      } else {
        const dstItems = [...(groupedTasks[dstCol] ?? [])];
        dstItems.splice(destination.index, 0, moved);
        for (let i = 0; i < srcItems.length; i++) {
          if (srcItems[i].position !== i) {
            void upsertTaskLocal({ id: srcItems[i].id, position: i });
          }
        }
        for (let i = 0; i < dstItems.length; i++) {
          void upsertTaskLocal({ id: dstItems[i].id, position: i, status: dstCol, ...extraFields });
        }
      }
    },
    [groupedTasks, columns, saveColumns]
  );

  const addColumn = () => {
    const newCol: KanbanColumn = {
      id: `col-${Date.now()}`,
      title: "Neue Spalte",
      color: COLUMN_COLORS[columns.length % COLUMN_COLORS.length],
    };
    void saveColumns([...columns, newCol]);
  };

  const removeColumn = (colId: string) => {
    if (columns.length <= 1) return;
    const tasks = groupedTasks[colId] ?? [];
    if (tasks.length > 0) {
      if (!confirm(`Spalte hat ${tasks.length} Aufgaben. Diese werden nach "${columns[0].title}" verschoben. Fortfahren?`)) return;
      const firstCol = columns.find((c) => c.id !== colId)!;
      for (const t of tasks) {
        void upsertTaskLocal({ id: t.id, status: firstCol.id });
      }
    }
    void saveColumns(columns.filter((c) => c.id !== colId));
  };

  const updateColumn = (colId: string, patch: Partial<KanbanColumn>) => {
    void saveColumns(columns.map((c) => (c.id === colId ? { ...c, ...patch } : c)));
  };

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 flex items-center justify-between border-b gap-2">
        <h1 className="text-lg font-semibold">Aufgaben</h1>
        <div className="flex items-center gap-2">
          {closedCount > 0 && (
            <button
              onClick={() => setShowClosed((v) => !v)}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-slate-100"
              title={showClosed ? "Geschlossene ausblenden" : "Geschlossene anzeigen"}
            >
              {showClosed ? <EyeOff size={14} /> : <Eye size={14} />}
              {showClosed ? "Geschlossene ausblenden" : `${closedCount} geschlossene`}
            </button>
          )}
          <button
            onClick={() => setEditingColumns((v) => !v)}
            className={`p-1.5 rounded hover:bg-slate-100 ${editingColumns ? "bg-slate-200" : ""}`}
            title="Spalten bearbeiten"
          >
            <Settings2 size={16} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-x-auto">
        <DragDropContext onDragEnd={onDragEnd}>
          <Droppable droppableId="board-columns" type="COLUMN" direction="horizontal">
            {(boardProvided) => (
              <div
                ref={boardProvided.innerRef}
                {...boardProvided.droppableProps}
                className="flex gap-4 p-4 h-full min-w-max"
              >
                {columns.map((col, colIndex) => (
                  <Draggable
                    key={col.id}
                    draggableId={`col-drag-${col.id}`}
                    index={colIndex}
                    isDragDisabled={!editingColumns}
                  >
                    {(colDragProvided, colDragSnapshot) => (
                      <div
                        ref={colDragProvided.innerRef}
                        {...colDragProvided.draggableProps}
                        className={colDragSnapshot.isDragging ? "opacity-80" : ""}
                      >
                        <KanbanColumnView
                          col={col}
                          tasks={groupedTasks[col.id] ?? []}
                          editing={editingColumns}
                          allTags={allTags}
                          onUpdate={(patch) => updateColumn(col.id, patch)}
                          onRemove={() => removeColumn(col.id)}
                          canRemove={columns.length > 1}
                          dragHandleProps={colDragProvided.dragHandleProps}
                        />
                      </div>
                    )}
                  </Draggable>
                ))}
                {boardProvided.placeholder}
                {editingColumns && (
                  <button
                    onClick={addColumn}
                    className="w-72 flex-shrink-0 rounded-lg border-2 border-dashed border-slate-300 flex items-center justify-center text-slate-400 hover:border-slate-400 hover:text-slate-500 transition-colors"
                  >
                    <Plus size={20} className="mr-1" /> Spalte hinzufügen
                  </button>
                )}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      </div>
    </div>
  );
}

function KanbanColumnView({
  col,
  tasks,
  editing,
  allTags,
  onUpdate,
  onRemove,
  canRemove,
  dragHandleProps,
}: {
  col: KanbanColumn;
  tasks: LocalTask[];
  editing: boolean;
  allTags: string[];
  onUpdate: (patch: Partial<KanbanColumn>) => void;
  onRemove: () => void;
  canRemove: boolean;
  dragHandleProps: DraggableProvidedDragHandleProps | null | undefined;
}) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [editTitle, setEditTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(col.title);

  useEffect(() => setTitleDraft(col.title), [col.title]);

  const addTask = () => {
    if (!newTitle.trim()) return;
    void upsertTaskLocal({
      id: uuid(),
      title: newTitle.trim(),
      status: col.id,
      position: tasks.length,
    });
    setNewTitle("");
    setAdding(false);
  };

  const saveTitle = () => {
    if (titleDraft.trim()) onUpdate({ title: titleDraft.trim() });
    setEditTitle(false);
  };

  return (
    <div className={`w-72 flex-shrink-0 rounded-lg ${col.color} flex flex-col max-h-full`}>
      <div className="px-3 py-2 font-medium text-sm flex items-center justify-between gap-1">
        {editing && (
          <div {...dragHandleProps} className="cursor-grab mr-1 text-slate-400 hover:text-slate-600">
            <GripHorizontal size={14} />
          </div>
        )}
        {editTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") setEditTitle(false); }}
            onBlur={saveTitle}
            className="flex-1 px-1 py-0.5 text-sm border rounded bg-white"
          />
        ) : (
          <span className="flex items-center gap-1">
            {col.title}{" "}
            <span className="text-xs text-slate-500">{tasks.length}</span>
            {col.done && <span className="text-xs text-emerald-600 ml-1">✓</span>}
          </span>
        )}
        <div className="flex items-center gap-0.5">
          {editing && !editTitle && (
            <>
              <button onClick={() => setEditTitle(true)} className="p-0.5 rounded hover:bg-black/10" title="Umbenennen">
                <Pencil size={12} />
              </button>
              <button
                onClick={() => onUpdate({ done: !col.done })}
                className={`p-0.5 rounded hover:bg-black/10 ${col.done ? "text-emerald-600" : "text-slate-400"}`}
                title={col.done ? "\"Erledigt\"-Spalte deaktivieren" : "Als \"Erledigt\"-Spalte markieren"}
              >
                <Check size={12} />
              </button>
              {canRemove && (
                <button onClick={onRemove} className="p-0.5 rounded hover:bg-red-100 text-red-500" title="Spalte entfernen">
                  <X size={12} />
                </button>
              )}
            </>
          )}
          {!editing && (
            <button onClick={() => setAdding(true)} className="p-1 rounded hover:bg-black/10" title="Aufgabe hinzufügen">
              <Plus size={16} />
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="px-3 pb-1 flex gap-1 flex-wrap">
          {COLUMN_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => onUpdate({ color: c })}
              className={`w-4 h-4 rounded-full ${c} border ${c === col.color ? "ring-2 ring-blue-400" : "border-slate-300"}`}
            />
          ))}
        </div>
      )}
      <Droppable droppableId={col.id} type="TASK">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`flex-1 min-h-[40px] overflow-y-auto px-2 pb-2 transition-colors ${
              snapshot.isDraggingOver ? "bg-black/5" : ""
            }`}
          >
            {tasks.map((task, index) => (
              <TaskCard key={task.id} task={task} index={index} allTags={allTags} isDoneColumn={!!col.done} />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
      {adding && (
        <div className="px-2 pb-2">
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addTask();
              if (e.key === "Escape") { setAdding(false); setNewTitle(""); }
            }}
            placeholder="Aufgabe…"
            className="w-full px-2 py-1 text-sm rounded border border-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <div className="flex gap-1 mt-1">
            <button onClick={addTask} className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700">
              Hinzufügen
            </button>
            <button onClick={() => { setAdding(false); setNewTitle(""); }} className="text-xs px-2 py-1 hover:bg-black/10 rounded">
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TagEditor({ tags, allTags, onChange }: { tags: string[]; allTags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(
    () => allTags.filter((t) => t.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t)),
    [allTags, tags, input]
  );

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed)) onChange([...tags, trimmed]);
    setInput("");
    setShowSuggestions(false);
    ref.current?.focus();
  };

  return (
    <div className="relative">
      <div className="flex flex-wrap gap-1 mb-1">
        {tags.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">
            {tag}
            <button onClick={() => onChange(tags.filter((t) => t !== tag))} className="hover:text-red-600">
              <X size={10} />
            </button>
          </span>
        ))}
      </div>
      <input
        ref={ref}
        value={input}
        onChange={(e) => { setInput(e.target.value); setShowSuggestions(true); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && input.trim()) { e.preventDefault(); addTag(input); }
          if (e.key === "Backspace" && !input && tags.length) onChange(tags.slice(0, -1));
          if (e.key === "Escape") setShowSuggestions(false);
        }}
        onFocus={() => setShowSuggestions(true)}
        onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
        placeholder="Tag…"
        className="w-full px-1 py-0.5 text-xs border rounded"
      />
      {showSuggestions && input && suggestions.length > 0 && (
        <div className="absolute z-10 bg-white border rounded shadow-md mt-0.5 max-h-24 overflow-y-auto w-full">
          {suggestions.slice(0, 8).map((s) => (
            <button key={s} onMouseDown={() => addTag(s)} className="block w-full text-left px-2 py-1 text-xs hover:bg-blue-50">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, index, allTags, isDoneColumn }: { task: LocalTask; index: number; allTags: string[]; isDoneColumn: boolean }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description ?? "");
  const [tags, setTags] = useState<string[]>(task.tags ?? []);

  useEffect(() => {
    setTitle(task.title);
    setDesc(task.description ?? "");
    setTags(task.tags ?? []);
  }, [task.title, task.description, task.tags]);

  const save = () => {
    void upsertTaskLocal({ id: task.id, title, description: desc || null, tags: tags.length ? tags : null });
    setEditing(false);
  };

  const remove = () => {
    if (confirm("Aufgabe löschen?")) {
      void deleteTaskLocal(task.id);
    }
  };

  const closeTask = () => {
    void upsertTaskLocal({ id: task.id, closed_at: new Date().toISOString() });
  };

  const reopenTask = () => {
    void upsertTaskLocal({ id: task.id, closed_at: null });
  };

  const priorityColors = ["", "text-blue-600", "text-amber-600", "text-red-600"];

  return (
    <Draggable draggableId={task.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          className={`bg-white rounded-lg shadow-sm border border-slate-200 p-2 mb-2 group ${
            snapshot.isDragging ? "shadow-lg ring-2 ring-blue-300" : ""
          } ${task.closed_at ? "opacity-60" : ""}`}
        >
          {editing ? (
            <div className="space-y-1">
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
                className="w-full px-1 py-0.5 text-sm border rounded"
              />
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="Beschreibung…"
                className="w-full px-1 py-0.5 text-xs border rounded resize-none"
                rows={2}
              />
              <TagEditor tags={tags} allTags={allTags} onChange={setTags} />
              <div className="flex gap-1">
                <button onClick={save} className="text-xs px-2 py-0.5 bg-blue-600 text-white rounded">Speichern</button>
                <button onClick={() => setEditing(false)} className="text-xs px-2 py-0.5 hover:bg-slate-100 rounded">Abbrechen</button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-1">
              <div {...provided.dragHandleProps} className="mt-0.5 cursor-grab opacity-0 group-hover:opacity-50 flex-shrink-0">
                <GripVertical size={14} />
              </div>
              <div className="flex-1 min-w-0" onClick={() => setEditing(true)}>
                <div className={`text-sm font-medium truncate cursor-pointer ${priorityColors[task.priority] ?? ""}`}>
                  {task.title || "Ohne Titel"}
                </div>
                {task.description && (
                  <div className="text-xs text-slate-500 truncate mt-0.5">{task.description}</div>
                )}
                {(task.tags ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {task.tags!.map((tag) => (
                      <span key={tag} className="px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded text-[10px]">
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-1">
                  {task.note_id && (
                    <Link
                      to={`/notes/${task.note_id}`}
                      className="text-xs text-blue-500 hover:underline flex items-center gap-0.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <LinkIcon size={10} /> Notiz
                    </Link>
                  )}
                  {task.due_date && (
                    <span className="text-xs text-slate-400">
                      {new Date(task.due_date).toLocaleDateString("de-DE")}
                    </span>
                  )}
                  {task.closed_at && (
                    <span className="text-xs text-slate-400">
                      geschlossen {new Date(task.closed_at).toLocaleDateString("de-DE")}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-0.5 flex-shrink-0">
                {task.closed_at ? (
                  <button
                    onClick={reopenTask}
                    className="opacity-0 group-hover:opacity-50 hover:!opacity-100 p-0.5"
                    title="Wieder öffnen"
                  >
                    <Eye size={14} />
                  </button>
                ) : isDoneColumn ? (
                  <button
                    onClick={closeTask}
                    className="opacity-0 group-hover:opacity-50 hover:!opacity-100 p-0.5 text-emerald-600"
                    title="Schließen"
                  >
                    <Check size={14} />
                  </button>
                ) : null}
                <button
                  onClick={remove}
                  className="opacity-0 group-hover:opacity-50 hover:!opacity-100 p-0.5"
                  title="Löschen"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Draggable>
  );
}
