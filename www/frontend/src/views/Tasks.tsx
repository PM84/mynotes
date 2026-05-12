import { useEffect, useState, useMemo, useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { db, type LocalTask, type TaskStatus } from "../db";
import { upsertTaskLocal, deleteTaskLocal, listLocalTasks } from "../sync";
import { Plus, Trash2, Link as LinkIcon, X, GripVertical } from "lucide-react";
import { Link } from "react-router-dom";
import { v4 as uuid } from "uuid";

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: "backlog", label: "Backlog", color: "bg-slate-100" },
  { id: "todo", label: "To Do", color: "bg-blue-50" },
  { id: "doing", label: "In Arbeit", color: "bg-amber-50" },
  { id: "done", label: "Erledigt", color: "bg-emerald-50" },
];

export function Tasks() {
  const allTasks = useLiveQuery(() => listLocalTasks(), [], []);

  const columns = useMemo(() => {
    const map: Record<TaskStatus, LocalTask[]> = { backlog: [], todo: [], doing: [], done: [] };
    for (const t of allTasks) {
      (map[t.status] ?? map.backlog).push(t);
    }
    // Sort by position within each column
    for (const col of Object.values(map)) {
      col.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [allTasks]);

  const onDragEnd = useCallback(
    (result: DropResult) => {
      const { source, destination, draggableId } = result;
      if (!destination) return;
      if (source.droppableId === destination.droppableId && source.index === destination.index) return;

      const srcCol = source.droppableId as TaskStatus;
      const dstCol = destination.droppableId as TaskStatus;

      // Build new list for destination column
      const srcItems = [...columns[srcCol]];
      const [moved] = srcItems.splice(source.index, 1);
      if (!moved) return;

      if (srcCol === dstCol) {
        srcItems.splice(destination.index, 0, moved);
        // Update positions
        for (let i = 0; i < srcItems.length; i++) {
          if (srcItems[i].position !== i || srcItems[i].id === moved.id) {
            void upsertTaskLocal({ id: srcItems[i].id, position: i, status: dstCol });
          }
        }
      } else {
        const dstItems = [...columns[dstCol]];
        dstItems.splice(destination.index, 0, moved);
        // Update source positions
        for (let i = 0; i < srcItems.length; i++) {
          if (srcItems[i].position !== i) {
            void upsertTaskLocal({ id: srcItems[i].id, position: i });
          }
        }
        // Update destination positions + status change
        for (let i = 0; i < dstItems.length; i++) {
          void upsertTaskLocal({ id: dstItems[i].id, position: i, status: dstCol });
        }
      }
    },
    [columns]
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-3 flex items-center justify-between border-b">
        <h1 className="text-lg font-semibold">Aufgaben</h1>
      </div>
      <div className="flex-1 min-h-0 overflow-x-auto">
        <DragDropContext onDragEnd={onDragEnd}>
          <div className="flex gap-4 p-4 h-full min-w-max">
            {COLUMNS.map((col) => (
              <KanbanColumn
                key={col.id}
                id={col.id}
                label={col.label}
                color={col.color}
                tasks={columns[col.id]}
              />
            ))}
          </div>
        </DragDropContext>
      </div>
    </div>
  );
}

function KanbanColumn({
  id,
  label,
  color,
  tasks,
}: {
  id: TaskStatus;
  label: string;
  color: string;
  tasks: LocalTask[];
}) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");

  const addTask = () => {
    if (!newTitle.trim()) return;
    void upsertTaskLocal({
      id: uuid(),
      title: newTitle.trim(),
      status: id,
      position: tasks.length,
    });
    setNewTitle("");
    setAdding(false);
  };

  return (
    <div className={`w-72 flex-shrink-0 rounded-lg ${color} flex flex-col max-h-full`}>
      <div className="px-3 py-2 font-medium text-sm flex items-center justify-between">
        <span>
          {label}{" "}
          <span className="text-xs text-slate-500 ml-1">{tasks.length}</span>
        </span>
        <button
          onClick={() => setAdding(true)}
          className="p-1 rounded hover:bg-black/10"
          title="Aufgabe hinzufügen"
        >
          <Plus size={16} />
        </button>
      </div>
      <Droppable droppableId={id}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`flex-1 min-h-[40px] overflow-y-auto px-2 pb-2 transition-colors ${
              snapshot.isDraggingOver ? "bg-black/5" : ""
            }`}
          >
            {tasks.map((task, index) => (
              <TaskCard key={task.id} task={task} index={index} />
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

function TaskCard({ task, index }: { task: LocalTask; index: number }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description ?? "");

  useEffect(() => {
    setTitle(task.title);
    setDesc(task.description ?? "");
  }, [task.title, task.description]);

  const save = () => {
    void upsertTaskLocal({ id: task.id, title, description: desc || null });
    setEditing(false);
  };

  const remove = () => {
    if (confirm("Aufgabe löschen?")) {
      void deleteTaskLocal(task.id);
    }
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
          }`}
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
                </div>
              </div>
              <button
                onClick={remove}
                className="opacity-0 group-hover:opacity-50 hover:!opacity-100 p-0.5 flex-shrink-0"
                title="Löschen"
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </Draggable>
  );
}
