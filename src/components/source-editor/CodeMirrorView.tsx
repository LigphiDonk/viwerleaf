import type { EditorView } from "@codemirror/view";
import { memo, useEffect, useRef } from "react";

function CodeMirrorViewInner({ view }: { view: EditorView }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || view.dom.parentElement === node) {
      return;
    }

    node.replaceChildren();
    node.appendChild(view.dom);
  }, [view]);

  useEffect(() => {
    return () => {
      view.destroy();
    };
  }, [view]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%", minHeight: 0 }} />;
}

const CodeMirrorView = memo(CodeMirrorViewInner);

export default CodeMirrorView;
