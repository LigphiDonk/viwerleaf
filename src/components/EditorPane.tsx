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
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { latex } from "../editor/languages/latex";
import type { ProjectFile } from "../types";
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
}

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
}: EditorPaneProps) {
  const activePathRef = useRef(file.path);
  const applyingExternalChangeRef = useRef(false);
  const [lineCount, setLineCount] = useState(() => file.content.split("\n").length);

  const onChangeRef = useRef(onChange);
  const onCursorChangeRef = useRef(onCursorChange);
  const onSaveRef = useRef(onSave);
  const onRunAgentRef = useRef(onRunAgent);
  const onCompileRef = useRef(onCompile);

  useEffect(() => {
    onChangeRef.current = onChange;
    onCursorChangeRef.current = onCursorChange;
    onSaveRef.current = onSave;
    onRunAgentRef.current = onRunAgent;
    onCompileRef.current = onCompile;
  }, [onChange, onCursorChange, onSave, onRunAgent, onCompile]);

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
    ]);

    return [
      latex(),
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      codeFolding(),
      foldGutter(),
      search({ top: true }),
      keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]),
      customKeymap,
    ];
  }, []);

  const viewRef = useRef<EditorView | null>(null);
  if (viewRef.current === null) {
    let view: EditorView;
    const initialState = EditorState.create({
      doc: file.content,
      extensions,
    });

    view = new EditorView({
      state: initialState,
      dispatchTransactions: (transactions: readonly Transaction[]) => {
        view.update(transactions);

        const docChanged = transactions.some((transaction) => transaction.docChanged);
        const selectionChanged =
          docChanged || transactions.some((transaction) => transaction.selection);

        if (docChanged) {
          setLineCount(view.state.doc.lines);
        }

        if (docChanged && !applyingExternalChangeRef.current) {
          onChangeRef.current(view.state.doc.toString());
        }

        if (selectionChanged) {
          const main = view.state.selection.main;
          const line = view.state.doc.lineAt(main.head).number;
          const selectedText = view.state.sliceDoc(main.from, main.to);
          onCursorChangeRef.current(line, selectedText);
        }
      },
    });

    viewRef.current = view;
  }

  const view = viewRef.current;

  useEffect(() => {
    setLineCount(view.state.doc.lines);
    const main = view.state.selection.main;
    const line = view.state.doc.lineAt(main.head).number;
    const selectedText = view.state.sliceDoc(main.from, main.to);
    onCursorChangeRef.current(line, selectedText);
  }, [view]);

  useEffect(() => {
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
  }, [file.content, file.path, view]);

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

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          padding: "6px 16px",
          borderBottom: "1px solid var(--border-light)",
          fontSize: "12px",
          color: "var(--text-secondary)",
          display: "flex",
          justifyContent: "space-between",
          background: "var(--bg-app)",
        }}
      >
        <span>
          源码路径: {file.path}
          {isDirty && <span style={{ color: "var(--danger)", marginLeft: 8 }}>● 未保存</span>}
        </span>
        <span>{file.language} · 共 {lineCount} 行</span>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <CodeMirrorView view={view} />
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
    previous.onCompile === next.onCompile
  );
}

export const EditorPane = memo(EditorPaneInner, areEditorPanePropsEqual);
