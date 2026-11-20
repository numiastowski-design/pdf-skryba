/** A PDF published as one tab per page, or as one flat page (docs/CONCEPTION-TECHNIQUE-PDF-ONGLETS.md §1.2, §2.1). */

import { describe, expect, it } from "vitest";

import { type IRBlock } from "doc-ir";
import { emptyTabBlocks } from "doc-ir/internal";
import { pdfPageTabs } from "./pdf-page-tabs";

const para = (text: string): IRBlock => ({ kind: "paragraph", inlines: [{ text }] });

describe("pdfPageTabs", () => {
  it("3 pages give 3 tabs numbered 1, 2, 3, in file order", () => {
    const doc = pdfPageTabs([[para("a")], [para("b")], [para("c")]], "en");
    expect(doc.blocks).toHaveLength(1);
    const tabs = doc.blocks[0]!.kind === "tabs" ? doc.blocks[0].tabs : [];
    expect(tabs.map((t) => t.pageNumber)).toEqual([1, 2, 3]);
    expect(tabs.map((t) => t.title)).toEqual(["Page 1", "Page 2", "Page 3"]);
    expect(tabs.map((t) => t.blocks)).toEqual([[para("a")], [para("b")], [para("c")]]);
  });

  it("a blank page is an empty tab, like an empty slide", () => {
    const doc = pdfPageTabs([[para("a")], []], "fr");
    const tabs = doc.blocks[0]!.kind === "tabs" ? doc.blocks[0].tabs : [];
    expect(tabs[1]!.blocks).toEqual(emptyTabBlocks());
  });

  it("a one-page PDF is one tab, and nothing comes before or after the tabs (no toc)", () => {
    const doc = pdfPageTabs([[para("a")]], "en");
    expect(doc.blocks.map((b) => b.kind)).toEqual(["tabs"]);
    expect(JSON.stringify(doc)).not.toContain('"toc"');
  });
});
