import { useMemo } from "react";
import {
  ReactFlow, MiniMap, Background, Controls,
  type Node, type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Idea, IdeaStatus } from "../types";

interface Props {
  ideas: Idea[];
  onOpen: (idea: Idea) => void;
  /** Persist a user-dragged node position. Pass null to revert to auto layout. */
  onMoveIdea?: (id: string, position: { x: number; y: number } | null) => void;
}

const STATUS_COLOR: Record<IdeaStatus, string> = {
  spark:     "#F59E0B",
  developing:"#3B82F6",
  ready:     "#10B981",
  promoted:  "#8B5CF6",
};

export function IdeaMindMap({ ideas, onOpen, onMoveIdea }: Props) {
  const { nodes, edges } = useMemo(() => buildGraph(ideas), [ideas]);

  // Empty state only when there are NO ideas. With one idea we still
  // show the map (a single node) so the user sees what they just added —
  // edges between ideas only appear when 2+ share articles.
  if (ideas.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-sm text-center space-y-3">
          <div className="text-3xl">🔬</div>
          <h3 className="font-display text-lg tracking-wide">Your idea map is empty</h3>
          <p className="text-sm text-text-muted leading-relaxed">
            Chat with your research in the center panel to spark some ideas, then save them
            here with <span className="text-accent-spark">💡 Save as idea</span>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-bg-primary bg-dot-grid bg-dot-24">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeDoubleClick={(_, node) => {
          if (node.data?.kind === "idea") {
            const idea = ideas.find((i) => i.id === node.id);
            if (idea) onOpen(idea);
          }
        }}
        onNodeDragStop={(_, node) => {
          if (node.data?.kind !== "idea" || !onMoveIdea) return;
          onMoveIdea(node.id, { x: node.position.x, y: node.position.y });
        }}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
      >
        <Background color="#2E3347" gap={24} size={1} />
        <Controls className="!bg-bg-surface !border-border" />
        <MiniMap
          className="!bg-bg-surface !border !border-border"
          nodeColor={(n) => (n.data?.kind === "idea" ? STATUS_COLOR[n.data.status as IdeaStatus] : "#6B7280")}
          maskColor="rgba(15, 17, 23, 0.6)"
        />
      </ReactFlow>
    </div>
  );
}

function buildGraph(ideas: Idea[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Article id → article title (we only have ids; fall back to id-prefix
  // when we don't have a label).
  const articleSeen = new Map<string, { ideas: Set<string> }>();
  for (const i of ideas) {
    for (const aid of i.linked_article_ids) {
      const e = articleSeen.get(aid) || { ideas: new Set<string>() };
      e.ideas.add(i.id);
      articleSeen.set(aid, e);
    }
  }

  // Layout: stored position wins; otherwise auto-place ideas on a ring.
  // Article nodes are always auto-placed near their connected ideas.
  const radius = 280;
  ideas.forEach((idea, idx) => {
    const angle = (idx / ideas.length) * Math.PI * 2;
    const auto = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    nodes.push({
      id: idea.id,
      position: idea.position ?? auto,
      data: {
        label: idea.title || "(untitled)",
        kind: "idea",
        status: idea.status,
      },
      style: ideaStyle(idea.status),
      type: "default",
    });
  });

  // Article nodes — placed near the centroid of their connected ideas.
  let aIdx = 0;
  for (const [aid, { ideas: ideaIds }] of articleSeen.entries()) {
    const idsArr = [...ideaIds];
    const positions = idsArr
      .map((id) => ideas.findIndex((i) => i.id === id))
      .filter((i) => i >= 0)
      .map((i) => {
        const angle = (i / ideas.length) * Math.PI * 2;
        return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      });
    const cx = positions.reduce((s, p) => s + p.x, 0) / Math.max(1, positions.length) * 0.55;
    const cy = positions.reduce((s, p) => s + p.y, 0) / Math.max(1, positions.length) * 0.55;
    nodes.push({
      id: `a:${aid}`,
      position: { x: cx + (aIdx % 5) * 12 - 24, y: cy + Math.floor(aIdx / 5) * 12 - 24 },
      data: { label: aid.slice(0, 8) + "…", kind: "article" },
      style: articleStyle(),
      type: "default",
    });
    for (const ideaId of idsArr) {
      const idea = ideas.find((i) => i.id === ideaId);
      if (!idea) continue;
      edges.push({
        id: `${ideaId}->${aid}`,
        source: ideaId,
        target: `a:${aid}`,
        style: { stroke: STATUS_COLOR[idea.status], strokeWidth: 1.5 },
      });
    }
    aIdx++;
  }

  // Idea ↔ Idea edges where they share ≥ 2 articles. Dashed gray.
  for (let i = 0; i < ideas.length; i++) {
    for (let j = i + 1; j < ideas.length; j++) {
      const a = new Set(ideas[i]!.linked_article_ids);
      const b = ideas[j]!.linked_article_ids.filter((x) => a.has(x));
      if (b.length >= 2) {
        edges.push({
          id: `${ideas[i]!.id}~${ideas[j]!.id}`,
          source: ideas[i]!.id,
          target: ideas[j]!.id,
          style: { stroke: "#6B7280", strokeDasharray: "4 4", strokeWidth: 1 },
          animated: false,
        });
      }
    }
  }

  return { nodes, edges };
}

function ideaStyle(status: IdeaStatus): React.CSSProperties {
  return {
    background: "#22263A",
    color: "#E8EAF0",
    border: `2px solid ${STATUS_COLOR[status]}`,
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 12,
    fontFamily: "IBM Plex Sans, system-ui",
    width: 180,
    opacity: status === "promoted" ? 0.6 : 1,
  };
}

function articleStyle(): React.CSSProperties {
  return {
    background: "#6B7280",
    color: "#F3F4F6",
    border: "1px solid #9CA3AF",
    borderRadius: 999,
    padding: "4px 10px",
    fontSize: 10,
    fontFamily: "DM Mono, monospace",
    width: 130,
  };
}
