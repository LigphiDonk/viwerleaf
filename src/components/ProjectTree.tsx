import { useEffect, useState } from "react";
import type { MouseEvent } from "react";

import type { ProjectNode } from "../types";

interface ProjectTreeProps {
  nodes: ProjectNode[];
  activeFile: string;
  dirtyPaths?: Set<string>;
  onOpenNode: (node: ProjectNode) => void;
  onCreateFile?: (parentDir: string, fileName: string) => void | Promise<void>;
  onCreateFolder?: (parentDir: string, folderName: string) => void | Promise<void>;
  onDeleteFile?: (path: string) => void | Promise<void>;
  onRenameFile?: (oldPath: string, newPath: string) => void | Promise<void>;
}

interface TreeNodeProps {
  node: ProjectNode;
  activeFile: string;
  dirtyPaths: Set<string>;
  collapsedDirs: Set<string>;
  depth: number;
  onOpenNode: (node: ProjectNode) => void;
  onToggleDirectory: (path: string) => void;
  onContextMenu: (event: MouseEvent, node: ProjectNode) => void;
}

function fileIcon(node: ProjectNode) {
  if (node.kind === "directory") {
    return "▾";
  }
  if (node.fileType === "pdf") {
    return "PDF";
  }
  if (node.fileType === "image") {
    return "IMG";
  }
  if (node.fileType === "bib") {
    return "BIB";
  }
  if (node.fileType === "json") {
    return "{ }";
  }
  return "T";
}

function ancestorDirectories(path: string) {
  const parts = path.split("/");
  const ancestors: string[] = [];

  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join("/"));
  }

  return ancestors;
}

function TreeNode({
  node,
  activeFile,
  dirtyPaths,
  collapsedDirs,
  depth,
  onOpenNode,
  onToggleDirectory,
  onContextMenu,
}: TreeNodeProps) {
  const paddingLeft = 8 + depth * 12;
  const isActive = node.path === activeFile;
  const isDirty = dirtyPaths.has(node.path);

  if (node.kind === "directory") {
    const isCollapsed = collapsedDirs.has(node.path);
    return (
      <>
        <div
          className="list-item"
          style={{ paddingLeft }}
          onClick={() => onToggleDirectory(node.path)}
          onContextMenu={(event) => onContextMenu(event, node)}
        >
          <span className="list-item-icon">{isCollapsed ? "▸" : "▾"}</span>
          <span>{node.name}</span>
        </div>
        {!isCollapsed &&
          node.children?.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              activeFile={activeFile}
              dirtyPaths={dirtyPaths}
              collapsedDirs={collapsedDirs}
              depth={depth + 1}
              onOpenNode={onOpenNode}
              onToggleDirectory={onToggleDirectory}
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
      onClick={() => onOpenNode(node)}
      onContextMenu={(event) => onContextMenu(event, node)}
    >
      <span className="list-item-icon">{fileIcon(node)}</span>
      <span>{node.name}</span>
      {isDirty && <span className="tree-dirty-dot" aria-hidden="true"></span>}
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
  dirtyPaths = new Set<string>(),
  onOpenNode,
  onCreateFile,
  onCreateFolder,
  onDeleteFile,
  onRenameFile,
}: ProjectTreeProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: ProjectNode } | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());

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

  useEffect(() => {
    if (!activeFile) {
      return;
    }

    const ancestors = ancestorDirectories(activeFile);
    if (!ancestors.length) {
      return;
    }

    setCollapsedDirs((current) => {
      const next = new Set(current);
      let changed = false;

      for (const path of ancestors) {
        if (next.delete(path)) {
          changed = true;
        }
      }

      return changed ? next : current;
    });
  }, [activeFile]);

  function handleContextMenu(event: MouseEvent, node: ProjectNode) {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, node });
  }

  function handleToggleDirectory(path: string) {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
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

  async function handleCreateFolder() {
    if (!contextMenu || !onCreateFolder) {
      return;
    }
    const parentDir =
      contextMenu.node.kind === "directory" ? contextMenu.node.path : dirname(contextMenu.node.path);
    const folderName = window.prompt("输入新文件夹名", "new-folder");
    setContextMenu(null);
    if (!folderName) {
      return;
    }
    await onCreateFolder(parentDir, folderName.trim());
  }

  async function handleRenameFile() {
    if (!contextMenu || !onRenameFile) {
      return;
    }
    const currentName = contextMenu.node.name;
    const nextName = window.prompt(
      contextMenu.node.kind === "directory" ? "输入新文件夹名" : "输入新文件名",
      currentName,
    );
    setContextMenu(null);
    if (!nextName || nextName.trim() === currentName) {
      return;
    }
    const parentDir = dirname(contextMenu.node.path);
    const newPath = parentDir ? `${parentDir}/${nextName.trim()}` : nextName.trim();
    await onRenameFile(contextMenu.node.path, newPath);
  }

  async function handleDeleteFile() {
    if (!contextMenu || !onDeleteFile) {
      return;
    }
    const confirmed = window.confirm(
      `确定删除${contextMenu.node.kind === "directory" ? "文件夹" : "文件"} ${contextMenu.node.name} 吗？`,
    );
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
          dirtyPaths={dirtyPaths}
          collapsedDirs={collapsedDirs}
          depth={0}
          onOpenNode={onOpenNode}
          onToggleDirectory={handleToggleDirectory}
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
          <button className="btn-secondary" style={{ width: "100%", marginBottom: 6 }} onClick={() => void handleCreateFolder()}>
            New Folder
          </button>
          <button className="btn-secondary" style={{ width: "100%", marginBottom: 6 }} onClick={() => void handleRenameFile()}>
            Rename
          </button>
          <button className="btn-secondary" style={{ width: "100%" }} onClick={() => void handleDeleteFile()}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
