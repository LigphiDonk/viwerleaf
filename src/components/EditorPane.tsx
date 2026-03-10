import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import { StreamLanguage, codeFolding, foldGutter, foldKeymap, foldService } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef } from "react";

import { buildFoldRanges } from "../lib/outline";
import type { ProjectFile } from "../types";

interface EditorPaneProps {
  file: ProjectFile;
  isDirty?: boolean;
  targetLine?: number;
  targetNonce?: number;
  openTabs: string[];
  onChange: (value: string) => void;
  onCursorChange: (line: number, selectedText: string) => void;
  onSelectTab: (path: string) => void;
  onSave?: (content: string) => void;
  onRunAgent?: () => void;
  onCompile?: () => void;
}

const latexLanguage = StreamLanguage.define(stex);

function latexCompletionSource(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/\\[a-zA-Z]*/);
  if (!word) {
    return null;
  }
  if (word.from === word.to && !context.explicit) {
    return null;
  }

  const commands = [
    { label: "\\begin{figure}", type: "keyword", apply: "\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{}\n\\caption{}\n\\label{fig:}\n\\end{figure}" },
    { label: "\\begin{table}", type: "keyword", apply: "\\begin{table}[htbp]\n\\centering\n\\begin{tabular}{}\n\\end{tabular}\n\\caption{}\n\\label{tab:}\n\\end{table}" },
    { label: "\\begin{equation}", type: "keyword", apply: "\\begin{equation}\n\\label{eq:}\n\\end{equation}" },
    { label: "\\begin{itemize}", type: "keyword", apply: "\\begin{itemize}\n\\item \n\\end{itemize}" },
    { label: "\\begin{enumerate}", type: "keyword", apply: "\\begin{enumerate}\n\\item \n\\end{enumerate}" },
    { label: "\\textbf{}", type: "function", apply: "\\textbf{}" },
    { label: "\\textit{}", type: "function", apply: "\\textit{}" },
    { label: "\\emph{}", type: "function", apply: "\\emph{}" },
    { label: "\\section{}", type: "keyword" },
    { label: "\\subsection{}", type: "keyword" },
    { label: "\\subsubsection{}", type: "keyword" },
    { label: "\\paragraph{}", type: "keyword" },
    { label: "\\cite{}", type: "function" },
    { label: "\\ref{}", type: "function" },
    { label: "\\label{}", type: "function" },
    { label: "\\eqref{}", type: "function" },
    { label: "\\frac{}{}", type: "function", apply: "\\frac{}{}" },
    { label: "\\sqrt{}", type: "function" },
    { label: "\\sum", type: "function" },
    { label: "\\int", type: "function" },
    { label: "\\alpha", type: "constant" },
    { label: "\\beta", type: "constant" },
    { label: "\\gamma", type: "constant" },
    { label: "\\lambda", type: "constant" },
    { label: "\\theta", type: "constant" },
    { label: "\\includegraphics[]{}", type: "function", apply: "\\includegraphics[width=0.8\\textwidth]{}" },
    { label: "\\input{}", type: "keyword" },
  ];

  return {
    from: word.from,
    options: commands,
  };
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
    const line = view.state.doc.line(lineNumber);
    lines.push(line);
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

export function EditorPane({
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
  const editorRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef(onSave);
  const onRunAgentRef = useRef(onRunAgent);
  const onCompileRef = useRef(onCompile);

  useEffect(() => {
    onSaveRef.current = onSave;
    onRunAgentRef.current = onRunAgent;
    onCompileRef.current = onCompile;
  }, [onCompile, onRunAgent, onSave]);

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
      latexLanguage,
      codeFolding(),
      foldGutter(),
      keymap.of(foldKeymap),
      search({ top: true }),
      keymap.of([...searchKeymap]),
      customKeymap,
      autocompletion({ override: [latexCompletionSource] }),
      foldService.of((state, lineStart) => {
        const foldRanges = buildFoldRanges(file.path, state.doc.toString());
        const line = state.doc.lineAt(lineStart);
        const foldRange = foldRanges.find((item) => item.fromLine === line.number);
        if (!foldRange) {
          return null;
        }

        const from = line.to;
        const to = state.doc.line(foldRange.toLine).to;
        return to > from ? { from, to } : null;
      }),
    ];
  }, [file.path]);

  useEffect(() => {
    if (!editorRef.current || !targetLine) {
      return;
    }

    const view = editorRef.current;
    const boundedLine = Math.max(1, Math.min(targetLine, view.state.doc.lines));
    const line = view.state.doc.line(boundedLine);
    const selection = EditorSelection.cursor(line.from);

    view.dispatch({
      selection,
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    view.focus();
  }, [file.path, targetLine, targetNonce]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "6px 16px", borderBottom: "1px solid var(--border-light)", fontSize: "12px", color: "var(--text-secondary)", display: "flex", justifyContent: "space-between", background: "var(--bg-app)" }}>
        <span>
          源码路径: {file.path}
          {isDirty && <span style={{ color: "var(--danger)", marginLeft: 8 }}>● 未保存</span>}
        </span>
        <span>{file.language} · 共 {file.content.split("\n").length} 行</span>
      </div>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <CodeMirror
          value={file.content}
          height="100%"
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            foldGutter: false,
          }}
          extensions={extensions}
          onCreateEditor={(view) => {
            editorRef.current = view;
          }}
          onChange={onChange}
          onUpdate={(update) => {
            if (update.selectionSet || update.docChanged) {
              const main = update.state.selection.main;
              const line = update.state.doc.lineAt(main.head).number;
              const selectedText = update.state.sliceDoc(main.from, main.to);
              onCursorChange(line, selectedText);
            }
          }}
        />
      </div>
    </div>
  );
}
