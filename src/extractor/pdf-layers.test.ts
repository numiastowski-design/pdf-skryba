/** The layers of a document, read from our dictionary (`pdf-layers.ts`). The expected verdicts are the ones pdf.js gave on this
 *  same file (`tools/poc/layers-shadow.ts` (deleted, see git history), 1/11/2026: ten groups, three hidden, zero disagreements). */
import { describe, expect, it } from "vitest";

import { layerConfigOf, type LayerGroup } from "./pdf-layers";
import { openPdfObjects } from "./pdf-objects/document";

/** A one-page PDF whose catalog names four groups: A on, B off (in /OFF), C hidden by its usage, D on. */
function layeredPdf(): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [4 0 R 5 0 R 6 0 R 7 0 R] /D << /BaseState /ON /OFF [5 0 R] >> >> >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 300 300] >>",
    "<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 12 0 R >>",
    "<< /Type /OCG /Name (A) >>",
    "<< /Type /OCG /Name (B) >>",
    "<< /Type /OCG /Name (C) /Usage << /View << /ViewState /OFF >> >> >>",
    "<< /Type /OCG /Name (D) >>",
  ];
  const content = "/OC /L1 BDC 0 0 1 rg 10 250 50 10 re f EMC";
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  let file = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(file.length);
    file += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = file.length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  return Uint8Array.from(
    Buffer.from(
      `${file}${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
      "latin1",
    ),
  );
}

const ocg = (id: string): LayerGroup => ({ type: "OCG", id });
const ocmd = (ids: string[], policy?: string): LayerGroup => ({
  type: "OCMD",
  ids,
  policy: policy ?? null,
  expression: null,
});

describe("layerConfigOf: the layers of the display, read from our dictionary", () => {
  const config = layerConfigOf(openPdfObjects(layeredPdf()));

  it("a group follows /BaseState, /ON and /OFF; a group whose view is OFF is hidden", () => {
    expect(config.isVisible(ocg("4R"))).toBe(true); // A, ON by default
    expect(config.isVisible(ocg("5R"))).toBe(false); // B, listed in /OFF
    expect(config.isVisible(ocg("6R"))).toBe(false); // C, /Usage /View /ViewState OFF
    expect(config.isVisible(ocg("7R"))).toBe(true); // D
  });

  it("a membership policy: AllOn is false as soon as one member is hidden; AnyOn needs only one", () => {
    expect(config.isVisible(ocmd(["4R", "5R"], "AllOn"))).toBe(false);
    expect(config.isVisible(ocmd(["4R", "7R"]))).toBe(true);
  });

  it("an AllOff policy is true when all members are hidden", () => {
    expect(config.isVisible(ocmd(["5R", "6R"], "AllOff"))).toBe(true);
  });

  it("a group the configuration does not name is shown, as pdf.js did", () => {
    expect(config.isVisible(ocg("99R"))).toBe(true);
    expect(config.isVisible(undefined)).toBe(true);
  });

  it("a group with an unknown policy is shown, as pdf.js did", () => {
    expect(config.isVisible(ocmd(["5R"], "Sometimes"))).toBe(true);
  });
});

describe("layerConfigOf: without /OCProperties, everything is shown", () => {
  it("returns true for any group, even one hidden elsewhere", () => {
    // Same length, so the cross-reference offsets stay right: the key is renamed, the layers are still in the file.
    const text = Buffer.from(layeredPdf()).toString("latin1").replace("/OCProperties", "/XCProperties");
    const config = layerConfigOf(openPdfObjects(Uint8Array.from(Buffer.from(text, "latin1"))));
    expect(config.isVisible(ocg("5R"))).toBe(true);
  });
});
