import { useMemo } from "react";
import {
  DndContext, useDraggable, useDroppable,
  PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { IdeaCard } from "./IdeaCard";
import type { Idea, IdeaStatus } from "../types";

const COLUMNS: Array<{ id: IdeaStatus; label: string; topBorder: string }> = [
  { id: "spark",      label: "Spark",      topBorder: "border-t-accent-spark" },
  { id: "developing", label: "Developing", topBorder: "border-t-accent-develop" },
  { id: "ready",      label: "Ready",      topBorder: "border-t-accent-ready" },
  { id: "promoted",   label: "Promoted",   topBorder: "border-t-accent-promoted" },
];

interface Props {
  ideas: Idea[];
  onAdvance: (id: string, status: IdeaStatus) => Promise<void>;
  onOpen: (idea: Idea) => void;
  onPromote: (idea: Idea) => void;
}

export function IdeaBoard({ ideas, onAdvance, onOpen, onPromote }: Props) {
  // 8px activation distance so a click without movement fires as a click
  // on the underlying buttons (Develop, Promote) instead of being
  // swallowed as a tiny drag. Without this, dnd-kit's default
  // PointerSensor activates on any pointer-down → button onClick never
  // fires, even though e.stopPropagation is called.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const grouped = useMemo(() => {
    const out: Record<IdeaStatus, Idea[]> = { spark: [], developing: [], ready: [], promoted: [] };
    for (const i of ideas) out[i.status].push(i);
    return out;
  }, [ideas]);

  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over) return;
    const newStatus = e.over.id as IdeaStatus;
    const ideaId = String(e.active.id);
    const idea = ideas.find((i) => i.id === ideaId);
    if (!idea || idea.status === newStatus) return;
    await onAdvance(ideaId, newStatus);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex-1 grid grid-cols-2 gap-3 px-3 py-3 overflow-y-auto scrollbar-thin">
        {COLUMNS.map((col) => (
          <DropColumn
            key={col.id}
            id={col.id}
            label={col.label}
            topBorder={col.topBorder}
            count={grouped[col.id].length}
          >
            {grouped[col.id].map((idea) => (
              <DraggableIdea key={idea.id} idea={idea}>
                <IdeaCard
                  idea={idea}
                  onAdvance={(status) => void onAdvance(idea.id, status)}
                  onPromote={() => onPromote(idea)}
                  onOpen={() => onOpen(idea)}
                />
              </DraggableIdea>
            ))}
          </DropColumn>
        ))}
      </div>
    </DndContext>
  );
}

function DropColumn({
  id, label, topBorder, count, children,
}: { id: IdeaStatus; label: string; topBorder: string; count: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={[
        "flex flex-col rounded-md border-t-2 border-bg-elevated p-2 min-h-[120px]",
        topBorder,
        isOver ? "bg-bg-elevated/40" : "",
      ].join(" ")}
    >
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="font-display text-[10px] uppercase tracking-widest text-text-muted">
          {label}
        </span>
        <span className="text-[10px] text-text-muted">{count}</span>
      </div>
      <div className="space-y-2 flex-1">{children}</div>
    </div>
  );
}

function DraggableIdea({ idea, children }: { idea: Idea; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: idea.id });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      {children}
    </div>
  );
}
