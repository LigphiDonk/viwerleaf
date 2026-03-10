import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { EditorView, keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

import type { ProjectFile } from "../types";

interface EditorPaneProps {
  file: ProjectFile;
  openTabs: string[];
  onChange: (value: string) => void;
  onCursorChange: (line: number, selectedText: string) => void;
  onSelectTab: (path: string) => void;
  onSave?: (content: string) => void;
  onRunAgent?: () => void;
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
  onChange,
  onCursorChange,
  onSave,
  onRunAgent,
}: EditorPaneProps) {
  const extensions = useMemo(() => {
    const customKeymap = keymap.of([
      {
        key: "Mod-s",
        run: (view) => {
          onSave?.(view.state.doc.toString());
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
          onRunAgent?.();
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
    ]);

    return [
      latexLanguage,
      search({ top: true }),
      keymap.of([...searchKeymap]),
      customKeymap,
      autocompletion({ override: [latexCompletionSource] }),
    ];
  }, [onRunAgent, onSave]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "6px 16px", borderBottom: "1px solid var(--border-light)", fontSize: "12px", color: "var(--text-secondary)", display: "flex", justifyContent: "space-between", background: "var(--bg-app)" }}>
        <span>源码路径: {file.path}</span>
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
