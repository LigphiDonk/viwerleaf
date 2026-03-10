import { useEffect, useState } from "react";
import type { MouseEvent } from "react";

import type { ProjectNode } from "../types";

interface ProjectTreeProps {
  nodes: ProjectNode[];
  activeFile: string;
  onOpenFile: (path: string) => void;
  onCreateFile?: (parentDir: string, fileName: string) => void | Promise<void>;
  onDeleteFile?: (path: string) => void | Promise<void>;
  onRenameFile?: (oldPath: string, newPath: string) => void | Promise<void>;
}

interface TreeNodeProps {
  node: ProjectNode;
  activeFile: string;
  depth: number;
  onOpenFile: (path: string) => void;
  onContextMenu: (event: MouseEvent, node: ProjectNode) => void;
}

function TreeNode({ node, activeFile, depth, onOpenFile, onContextMenu }: TreeNodeProps) {
  const paddingLeft = 8 + depth * 12;
  const isActive = node.path === activeFile;

  if (node.kind === "directory") {
    return (
      <>
        <div
          className="list-item"
          style={{ paddingLeft }}
          onContextMenu={(event) => onContextMenu(event, node)}
        >
          <span className="list-item-icon">▾</span>
          <span>{node.name}</span>
        </div>
        {node.children?.map((child) => (
          <TreeNode
            key={child.id}
            node={child}
            activeFile={activeFile}
            depth={depth + 1}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
          />
        ))}
      </>
    );
  }

  return (
    <div
      className={`list-item ${isActive ? "is-active" : ""}`}
      style={{ paddingLeft }}
      onClick={() => onOpenFile(node.path)}
      onContextMenu={(event) => onContextMenu(event, node)}
    >
      <span className="list-item-icon">{node.kind === "asset" ? "🖼" : "📄"}</span>
      <span>{node.name}</span>
    </div>
  );
}

function dirname(path: string) {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

export function ProjectTree({
  nodes,
  activeFile,
  onOpenFile,
  onCreateFile,
  onDeleteFile,
  onRenameFile,
}: ProjectTreeProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: ProjectNode } | null>(null);

  useEffect(() => {
    function closeMenu() {
      setContextMenu(null);
    }

    window.addEventListener("click", closeMenu);
    window.addEventListener("blur", closeMenu);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("blur", closeMenu);
    };
  }, []);

  function handleContextMenu(event: MouseEvent, node: ProjectNode) {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  }

  async function handleCreateFile() {
    if (!contextMenu || !onCreateFile) {
      return;
    }
    const parentDir =
      contextMenu.node.kind === "directory" ? contextMenu.node.path : dirname(contextMenu.node.path);
    const fileName = window.prompt("输入新文件名", "new-section.tex");
    setContextMenu(null);
    if (!fileName) {
      return;
    }
    await onCreateFile(parentDir, fileName.trim());
  }

  async function handleRenameFile() {
    if (!contextMenu || !onRenameFile || contextMenu.node.kind === "directory") {
      return;
    }
    const currentName = contextMenu.node.name;
    const nextName = window.prompt("输入新文件名", currentName);
    setContextMenu(null);
    if (!nextName || nextName.trim() === currentName) {
      return;
    }
    const parentDir = dirname(contextMenu.node.path);
    const newPath = parentDir ? `${parentDir}/${nextName.trim()}` : nextName.trim();
    await onRenameFile(contextMenu.node.path, newPath);
  }

  async function handleDeleteFile() {
    if (!contextMenu || !onDeleteFile || contextMenu.node.kind === "directory") {
      return;
    }
    const confirmed = window.confirm(`确定删除 ${contextMenu.node.name} 吗？`);
    setContextMenu(null);
    if (!confirmed) {
      return;
    }
    await onDeleteFile(contextMenu.node.path);
  }

  return (
    <div style={{ padding: "0 8px", position: "relative" }}>
      {nodes.map((node) => (
        <TreeNode
          key={node.id}
          node={node}
          activeFile={activeFile}
          depth={0}
          onOpenFile={onOpenFile}
          onContextMenu={handleContextMenu}
        />
      ))}

      {contextMenu && (
        <div
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 1000,
            minWidth: 148,
            padding: 6,
            borderRadius: 10,
            border: "1px solid var(--border-light)",
            background: "var(--bg-surface)",
            boxShadow: "var(--shadow-lg)",
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button className="btn-secondary" style={{ width: "100%", marginBottom: 6 }} onClick={() => void handleCreateFile()}>
            New File
          </button>
          {contextMenu.node.kind !== "directory" && (
            <>
              <button className="btn-secondary" style={{ width: "100%", marginBottom: 6 }} onClick={() => void handleRenameFile()}>
                Rename
              </button>
              <button className="btn-secondary" style={{ width: "100%" }} onClick={() => void handleDeleteFile()}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
