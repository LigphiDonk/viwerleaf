import { describe, expect, it } from "vitest";

import {
  buildFoldRanges,
  buildProjectOutline,
  findActiveHeading,
  parseLatexStructure,
  resolveIncludePath,
} from "./outline";

describe("outline helpers", () => {
  it("parses section headings and ignores commented entries", () => {
    const parsed = parseLatexStructure(
      "sections/introduction.tex",
      [
        "% \\section{Ignored}",
        "\\section{Introduction}",
        "\\subsection*{Scope}",
        "Text",
      ].join("\n"),
    );

    expect(parsed.headings).toHaveLength(2);
    expect(parsed.headings.map((item) => item.title)).toEqual(["Introduction", "Scope"]);
    expect(parsed.headings.map((item) => item.line)).toEqual([2, 3]);
  });

  it("resolves include paths relative to the including file", () => {
    expect(resolveIncludePath("main.tex", "sections/method")).toBe("sections/method.tex");
    expect(resolveIncludePath("chapters/main.tex", "../appendix/proof.tex")).toBe("appendix/proof.tex");
  });

  it("builds a project outline in main document include order and skips cycles", async () => {
    const files = new Map<string, string>([
      [
        "main.tex",
        [
          "\\section{Overview}",
          "\\input{sections/intro}",
          "\\include{sections/method}",
        ].join("\n"),
      ],
      [
        "sections/intro.tex",
        [
          "\\section{Intro}",
          "\\input{sections/method}",
        ].join("\n"),
      ],
      [
        "sections/method.tex",
        "\\subsection{Pipeline}",
      ],
    ]);

    const outline = await buildProjectOutline("main.tex", async (path) => {
      const content = files.get(path);
      if (!content) {
        throw new Error(`missing ${path}`);
      }
      return content;
    });

    expect(outline.headings.map((item) => `${item.filePath}:${item.title}`)).toEqual([
      "main.tex:Overview",
      "sections/intro.tex:Intro",
      "sections/method.tex:Pipeline",
    ]);
    expect(outline.warnings).toEqual([]);
  });

  it("reports missing included files as warnings", async () => {
    const outline = await buildProjectOutline("main.tex", async (path) => {
      if (path === "main.tex") {
        return "\\input{sections/missing}";
      }
      throw new Error("not found");
    });

    expect(outline.headings).toEqual([]);
    expect(outline.warnings).toHaveLength(1);
  });

  it("computes fold ranges and active headings", () => {
    const content = [
      "\\section{Introduction}",
      "Intro text",
      "",
      "\\subsection{Context}",
      "Context text",
      "\\section{Method}",
      "Method text",
    ].join("\n");

    const foldRanges = buildFoldRanges("sections/intro.tex", content);
    expect(foldRanges.map((item) => [item.fromLine, item.toLine])).toEqual([
      [1, 5],
      [4, 5],
      [6, 7],
    ]);

    const parsed = parseLatexStructure("sections/intro.tex", content);
    expect(findActiveHeading(parsed.headings, "sections/intro.tex", 5)?.title).toBe("Context");
    expect(findActiveHeading(parsed.headings, "sections/intro.tex", 7)?.title).toBe("Method");
  });
});
