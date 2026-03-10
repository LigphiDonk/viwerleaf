import { useEffect, useMemo, useState } from "react";

import type { OutlineNode } from "../lib/outline";

interface OutlineTreeProps {
  nodes: OutlineNode[];
  activeId?: string;
  onSelectNode: (node: OutlineNode) => void;
}

function collectAncestorIds(nodes: OutlineNode[], targetId?: string, trail: string[] = []): string[] {
  if (!targetId) {
    return [];
  }

  for (const node of nodes) {
    if (node.id === targetId) {
      return trail;
    }
    const childTrail = collectAncestorIds(node.children, targetId, [...trail, node.id]);
    if (childTrail.length) {
      return childTrail;
    }
  }

  return [];
}

function OutlineBranch({
  node,
  depth,
  activeId,
  collapsedIds,
  onToggle,
  onSelectNode,
}: {
  node: OutlineNode;
  depth: number;
  activeId?: string;
  collapsedIds: Set<string>;
  onToggle: (id: string) => void;
  onSelectNode: (node: OutlineNode) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = hasChildren && collapsedIds.has(node.id);
  const isActive = node.id === activeId;

  return (
    <>
      <div
        className={`list-item outline-item ${isActive ? "is-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelectNode(node)}
      >
        <button
          type="button"
          className={`outline-caret ${hasChildren ? "" : "is-placeholder"}`}
          onClick={(event) => {
            event.stopPropagation();
            if (hasChildren) {
              onToggle(node.id);
            }
          }}
          aria-label={hasChildren ? (isCollapsed ? "展开章节" : "折叠章节") : "无子章节"}
        >
          {hasChildren ? (isCollapsed ? "▸" : "▾") : "·"}
        </button>
        <div className="outline-copy">
          <div className="outline-title">{node.heading.title}</div>
          <div className="outline-meta">
            {node.heading.filePath}:{node.heading.line}
          </div>
        </div>
      </div>
      {!isCollapsed &&
        node.children.map((child) => (
          <OutlineBranch
            key={child.id}
            node={child}
            depth={depth + 1}
            activeId={activeId}
            collapsedIds={collapsedIds}
            onToggle={onToggle}
            onSelectNode={onSelectNode}
          />
        ))}
    </>
  );
}

export function OutlineTree({ nodes, activeId, onSelectNode }: OutlineTreeProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());

  const ancestorIds = useMemo(() => collectAncestorIds(nodes, activeId), [activeId, nodes]);

  useEffect(() => {
    if (!ancestorIds.length) {
      return;
    }

    setCollapsedIds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const id of ancestorIds) {
        if (next.delete(id)) {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [ancestorIds]);

  function toggleNode(id: string) {
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  if (!nodes.length) {
    return <div className="text-subtle text-sm" style={{ padding: "12px 8px" }}>未找到章节结构</div>;
  }

  return (
    <div style={{ padding: "4px 0" }}>
      {nodes.map((node) => (
        <OutlineBranch
          key={node.id}
          node={node}
          depth={0}
          activeId={activeId}
          collapsedIds={collapsedIds}
          onToggle={toggleNode}
          onSelectNode={onSelectNode}
        />
      ))}
    </div>
  );
}
