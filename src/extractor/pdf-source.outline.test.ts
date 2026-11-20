import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { readPdfSource } from "./pdf-source";

/** A 2-page PDF whose outline is: A > (A1, A2), B. Built with the low-level objects: /First /Last /Next /Parent. */
const pdfWithOutline = async (): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  doc.addPage();
  const page = doc.getPage(0).ref;
  const { context } = doc;
  const make = (title: string, parent: PDFRef): PDFDict => {
    const dict = context.obj({ Title: PDFHexString.fromText(title), Parent: parent, Dest: [page, PDFName.of("Fit")] });
    return dict;
  };
  const rootRef = context.nextRef();
  const aRef = context.register(make("A", rootRef));
  const a1Ref = context.register(make("A1", aRef));
  const a2Ref = context.register(make("A2", aRef));
  const bRef = context.register(make("B", rootRef));
  const set = (ref: PDFRef, key: string, value: PDFRef | number) =>
    (context.lookup(ref) as PDFDict).set(PDFName.of(key), typeof value === "number" ? context.obj(value) : value);
  set(aRef, "First", a1Ref);
  set(aRef, "Last", a2Ref);
  set(aRef, "Count", 2);
  set(a1Ref, "Next", a2Ref);
  set(a2Ref, "Prev", a1Ref);
  set(aRef, "Next", bRef);
  set(bRef, "Prev", aRef);
  context.assign(rootRef, context.obj({ Type: "Outlines", First: aRef, Last: bRef, Count: 4 }));
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  return doc.save();
};

describe("readPdfSource outline", () => {
  it("flattens the bookmarks in reading order with their depth", async () => {
    const source = await readPdfSource(await pdfWithOutline());
    expect(source.outline).toStrictEqual([
      { title: "A", depth: 1 },
      { title: "A1", depth: 2 },
      { title: "A2", depth: 2 },
      { title: "B", depth: 1 },
    ]);
  });

  it("gives no outline to a PDF without bookmarks", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    expect((await readPdfSource(await doc.save())).outline).toBeUndefined();
  });
});
