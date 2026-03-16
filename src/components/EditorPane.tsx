import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { codeFolding, foldGutter, foldKeymap } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { latex } from "../editor/languages/latex";
import { commentGutter, setCommentMarkers } from "../editor/extensions/comment-gutter";
import type { CollabStatus, ProjectFile, ReviewComment } from "../types";
import CodeMirrorView from "./source-editor/CodeMirrorView";

interface EditorPaneProps {
  file: ProjectFile;
  isDirty?: boolean;
  targetLine?: number;
  targetNonce?: number;
  onChange: (value: string) => void;
  onCursorChange: (line: number, selectedText: string) => void;
  onSave?: (content: string) => void;
  onRunAgent?: () => void;
  onCompile?: () => void;
  onForwardSync?: () => void;
  yText?: Y.Text | null;
  awareness?: Awareness | null;
  collabStatus?: CollabStatus | null;
  comments?: ReviewComment[];
  onAddComment?: (
    lineStart: number,
    lineEnd: number,
    selectedText: string,
    commentText?: string,
  ) => void;
}

type CommentPopoverState = {
  mode: "trigger" | "composer";
  lineStart: number;
  lineEnd: number;
  selectedText: string;
  draftText: string;
  anchorLeft: number;
  anchorTop: number;
};

function wrapSelection(view: EditorView, before: string, after: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  });
}

function toggleLatexComment(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from).number;
  const endLine = view.state.doc.lineAt(to).number;
  const lines = [];

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    lines.push(view.state.doc.line(lineNumber));
  }

  const shouldUncomment = lines.every((line) => line.text.trimStart().startsWith("%"));
  const changes = lines.map((line) => {
    const leadingWhitespace = line.text.match(/^\s*/)?.[0] ?? "";
    if (shouldUncomment) {
      const index = line.from + leadingWhitespace.length;
      return { from: index, to: index + 1, insert: "" };
    }
    const insertAt = line.from + leadingWhitespace.length;
    return { from: insertAt, to: insertAt, insert: "%" };
  });

  view.dispatch({ changes });
  return true;
}

function EditorPaneInner({
  file,
  isDirty,
  targetLine,
  targetNonce,
  onChange,
  onCursorChange,
  onSave,
  onRunAgent,
  onCompile,
  onForwardSync,
  yText,
  awareness,
  collabStatus,
  comments,
  onAddComment,
}: EditorPaneProps) {
  const activePathRef = useRef(file.path);
  const applyingExternalChangeRef = useRef(false);
  const editorSurfaceRef = useRef<HTMLDivElement | null>(null);
  const commentTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const openCommentComposerRef = useRef<(view: EditorView, allowCollapsedSelection?: boolean) => void>(() => {});
  const syncSelectionCommentTriggerRef = useRef<(view: EditorView) => void>(() => {});
  const [lineCount, setLineCount] = useState(() => file.content.split("\n").length);
  const [commentPopover, setCommentPopover] = useState<CommentPopoverState | null>(null);
  const isCollaborative = Boolean(yText && awareness);
  const canAddComment = Boolean(collabStatus?.enabled && onAddComment);

  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  const onSaveRef = useRef(onSave);
  const onRunAgentRef = useRef(onRunAgent);
  const onCompileRef = useRef(onCompile);
  const onForwardSyncRef = useRef(onForwardSync);
  const onAddCommentRef = useRef(onAddComment);

  useEffect(() => {
    onChangeRef.current = onChange;
    onCursorChangeRef.current = onCursorChange;
    onSaveRef.current = onSave;
    onRunAgentRef.current = onRunAgent;
    onCompileRef.current = onCompile;
    onForwardSyncRef.current = onForwardSync;
    onAddCommentRef.current = onAddComment;
  }, [onChange, onCursorChange, onSave, onRunAgent, onCompile, onForwardSync, onAddComment]);

  function buildCommentPopoverState(
    nextView: EditorView,
    mode: CommentPopoverState["mode"],
    allowCollapsedSelection = false,
    draftText = "",
  ) {
    if (!canAddComment) {
      return null;
    }

    const selection = nextView.state.selection.main;
    const hasSelection = selection.from !== selection.to;
    if (!allowCollapsedSelection && !hasSelection) {
      return null;
    }

    const root = editorSurfaceRef.current;
    if (!root) {
      return null;
    }

    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    const anchorPos = hasSelection ? to : selection.head;
    const startCoords = nextView.coordsAtPos(from);
    const endCoords = nextView.coordsAtPos(anchorPos);
    const rootRect = root.getBoundingClientRect();

    if (!startCoords || !endCoords) {
      return null;
    }

    const composerWidth = 320;
    const composerHeight = 188;
    const left = Math.min(
      Math.max(16, endCoords.right - rootRect.left + 14),
      Math.max(16, rootRect.width - composerWidth - 16),
    );
    const centerY = ((startCoords.top + endCoords.bottom) / 2) - rootRect.top;
    const top = Math.min(
      Math.max(16, centerY - 18),
      Math.max(16, rootRect.height - composerHeight - 16),
    );

    return {
      mode,
      lineStart: nextView.state.doc.lineAt(from).number,
      lineEnd: nextView.state.doc.lineAt(anchorPos).number,
      selectedText: nextView.state.sliceDoc(from, to),
      draftText,
      anchorLeft: left,
      anchorTop: top,
    } satisfies CommentPopoverState;
  }

  function syncSelectionCommentTrigger(nextView: EditorView) {
    setCommentPopover((current) => {
      if (current?.mode === "composer") {
        return current;
      }
      return buildCommentPopoverState(nextView, "trigger");
    });
  }

  function openCommentComposer(nextView: EditorView, allowCollapsedSelection = false) {
    setCommentPopover((current) =>
      buildCommentPopoverState(
        nextView,
        "composer",
        allowCollapsedSelection,
        current?.mode === "composer" ? current.draftText : "",
      ),
    );
  }

  openCommentComposerRef.current = openCommentComposer;
  syncSelectionCommentTriggerRef.current = syncSelectionCommentTrigger;

  const extensions = useMemo(() => {
    const customKeymap = keymap.of([
      {
        key: "Mod-s",
        run: (view) => {
          onSaveRef.current?.(view.state.doc.toString());
          return true;
        },
      },
      {
        key: "Mod-b",
        run: (view) => {
          wrapSelection(view, "\\textbf{", "}");
          return true;
        },
      },
      {
        key: "Mod-i",
        run: (view) => {
          wrapSelection(view, "\\textit{", "}");
          return true;
        },
      },
      {
        key: "Mod-Enter",
        run: () => {
          onRunAgentRef.current?.();
          return true;
        },
      },
      {
        key: "Mod-/",
        run: (view) => toggleLatexComment(view),
      },
      {
        key: "Mod-h",
        run: (view) => {
          openSearchPanel(view);
          return true;
        },
      },
      {
        key: "Mod-Shift-b",
        run: () => {
          onCompileRef.current?.();
          return true;
        },
      },
      {
        key: "Mod-Shift-j",
        run: () => {
          onForwardSyncRef.current?.();
          return true;
        },
      },
      {
        key: "Mod-Shift-m",
        run: (view) => {
          openCommentComposerRef.current(view, true);
          return true;
        },
      },
    ]);

    return [
      latex(),
      EditorView.lineWrapping,
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      codeFolding(),
      foldGutter(),
      search({ top: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]),
      customKeymap,
      commentGutter(),
      ...(isCollaborative && yText && awareness
        ? [yCollab(yText, awareness, { undoManager: new Y.UndoManager(yText) })]
        : []),
    ];
  }, [awareness, isCollaborative, yText]);

  const view = useMemo(() => {
    let nextView: EditorView;
    const initialState = EditorState.create({
      doc: isCollaborative && yText ? yText.toString() : file.content,
      extensions,
    });

    nextView = new EditorView({
      state: initialState,
      dispatchTransactions: (transactions: readonly Transaction[]) => {
        nextView.update(transactions);

        const docChanged = transactions.some((transaction) => transaction.docChanged);
        const selectionChanged =
          docChanged || transactions.some((transaction) => transaction.selection);

        if (docChanged) {
          setLineCount(nextView.state.doc.lines);
        }

        if (!isCollaborative && docChanged && !applyingExternalChangeRef.current) {
          onChangeRef.current(nextView.state.doc.toString());
        }

        if (selectionChanged) {
          const main = nextView.state.selection.main;
          const line = nextView.state.doc.lineAt(main.head).number;
          const selectedText = nextView.state.sliceDoc(main.from, main.to);
          onCursorChangeRef.current(line, selectedText);
          syncSelectionCommentTriggerRef.current(nextView);
        }
      },
    });

    return nextView;
  }, [extensions, isCollaborative, yText]);

  useEffect(() => {
    setLineCount(view.state.doc.lines);
    const main = view.state.selection.main;
    const line = view.state.doc.lineAt(main.head).number;
    const selectedText = view.state.sliceDoc(main.from, main.to);
    onCursorChangeRef.current(line, selectedText);
    syncSelectionCommentTrigger(view);
  }, [view]);

  useEffect(() => {
    if (isCollaborative) {
      activePathRef.current = file.path;
      return;
    }

    const pathChanged = activePathRef.current !== file.path;
    const currentText = view.state.doc.toString();
    const contentChanged = currentText !== file.content;

    if (!pathChanged && !contentChanged) {
      return;
    }

    activePathRef.current = file.path;
    applyingExternalChangeRef.current = true;
    try {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: file.content,
        },
        selection: pathChanged ? EditorSelection.cursor(0) : view.state.selection,
      });
    } finally {
      applyingExternalChangeRef.current = false;
    }

    setLineCount(view.state.doc.lines);
  }, [file.content, file.path, isCollaborative, view]);

  useEffect(() => {
    setCommentPopover(null);
  }, [file.path]);

  useEffect(() => {
    if (!targetLine) {
      return;
    }

    const boundedLine = Math.max(1, Math.min(targetLine, view.state.doc.lines));
    const line = view.state.doc.line(boundedLine);

    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }, [targetLine, targetNonce, view]);

  useEffect(() => {
    if (!comments) return;
    const markers = comments
      .filter((c) => !c.resolved && c.filePath === file.path)
      .map((c) => ({ line: c.lineStart, color: c.userColor }));
    view.dispatch({ effects: setCommentMarkers.of(markers) });
  }, [comments, file.path, view]);

  useEffect(() => {
    if (!canAddComment) {
      setCommentPopover(null);
      return;
    }
    syncSelectionCommentTrigger(view);
  }, [canAddComment, view]);

  useEffect(() => {
    if (commentPopover?.mode !== "composer") {
      return;
    }
    commentTextareaRef.current?.focus();
    commentTextareaRef.current?.setSelectionRange(
      commentTextareaRef.current.value.length,
      commentTextareaRef.current.value.length,
    );
  }, [commentPopover]);

  useEffect(() => {
    if (!commentPopover) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.closest("[data-comment-overlay='true']") || target.closest(".cm-editor")) {
        return;
      }
      setCommentPopover(null);
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [commentPopover]);

  function handleAddCommentClick() {
    openCommentComposer(view, true);
  }

  function handleSubmitComment() {
    if (commentPopover?.mode !== "composer") {
      return;
    }
    const text = commentPopover.draftText.trim();
    if (!text) {
      return;
    }
    onAddCommentRef.current?.(
      commentPopover.lineStart,
      commentPopover.lineEnd,
      commentPopover.selectedText,
      text,
    );
    setCommentPopover(null);
    view.focus();
  }

  return (
    <div className="editor-pane-shell">
      <div
        className="editor-pane-toolbar"
      >
        <span className="editor-pane-toolbar-meta">
          源码路径: {file.path}
          {isDirty && <span style={{ color: "var(--danger)", marginLeft: 8 }}>● 未保存</span>}
          {collabStatus?.enabled && (
            <span style={{ color: "var(--text-secondary)", marginLeft: 8 }}>
              · {collabStatus.synced ? "协作已同步" : collabStatus.connectionError ? "协作异常" : "协作连接中"}
            </span>
          )}
        </span>
        <div className="editor-pane-toolbar-actions">
          <span className="editor-pane-toolbar-info">
            {file.language} · 共 {lineCount} 行
            {collabStatus?.enabled && ` · ${collabStatus.members.length + 1} 人`}
          </span>
          <button
            className="btn-secondary"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleAddCommentClick}
            disabled={!canAddComment}
            title={canAddComment ? "为当前选择添加批注（Cmd+Shift+M）" : "连接云协作后可用"}
          >
            添加批注
          </button>
        </div>
      </div>
      <div className="editor-pane-surface" ref={editorSurfaceRef}>
        <CodeMirrorView view={view} />
        {commentPopover?.mode === "trigger" && (
          <button
            type="button"
            className="editor-comment-trigger"
            data-comment-overlay="true"
            style={{
              left: `${commentPopover.anchorLeft}px`,
              top: `${commentPopover.anchorTop}px`,
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => openCommentComposer(view)}
          >
            <span>Comment</span>
            <span className="editor-comment-trigger-shortcut">⌘⇧M</span>
          </button>
        )}
        {commentPopover?.mode === "composer" && (
          <div
            className="editor-comment-popover"
            data-comment-overlay="true"
            style={{
              left: `${commentPopover.anchorLeft}px`,
              top: `${commentPopover.anchorTop}px`,
            }}
          >
            <textarea
              ref={commentTextareaRef}
              className="editor-comment-input"
              value={commentPopover.draftText}
              onChange={(event) => {
                const nextText = event.target.value;
                setCommentPopover((current) =>
                  current?.mode === "composer"
                    ? { ...current, draftText: nextText }
                    : current,
                );
              }}
              placeholder="Leave a comment"
              rows={3}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  handleSubmitComment();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCommentPopover(null);
                  view.focus();
                }
              }}
            />
            <div className="editor-comment-popover-actions">
              <button
                type="button"
                className="editor-comment-cancel"
                onClick={() => {
                  setCommentPopover(null);
                  view.focus();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="editor-comment-submit"
                disabled={!commentPopover.draftText.trim()}
                onClick={handleSubmitComment}
              >
                Add Comment
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function areEditorPanePropsEqual(previous: EditorPaneProps, next: EditorPaneProps) {
  return (
    previous.file.path === next.file.path &&
    previous.file.language === next.file.language &&
    previous.file.content === next.file.content &&
    previous.isDirty === next.isDirty &&
    previous.targetLine === next.targetLine &&
    previous.targetNonce === next.targetNonce &&
    previous.onChange === next.onChange &&
    previous.onCursorChange === next.onCursorChange &&
    previous.onSave === next.onSave &&
    previous.onRunAgent === next.onRunAgent &&
    previous.onCompile === next.onCompile &&
    previous.onForwardSync === next.onForwardSync &&
    previous.yText === next.yText &&
    previous.awareness === next.awareness &&
    previous.comments === next.comments &&
    previous.collabStatus?.enabled === next.collabStatus?.enabled &&
    previous.collabStatus?.synced === next.collabStatus?.synced &&
    previous.collabStatus?.connectionError === next.collabStatus?.connectionError &&
    previous.collabStatus?.members.length === next.collabStatus?.members.length
  );
}

export const EditorPane = memo(EditorPaneInner, areEditorPanePropsEqual);
