/** The document's fiche read from our dictionary (`pdf-document-info.ts`), rule by rule — each comes from a gap
 *  that the measurement on 415 files revealed, and that pdf.js settled (removed since, on 01/11/2026). Measurement: `tools/poc/info-shadow.ts` (deleted, see git history), 415 out of 415. */
import { describe, expect, it } from "vitest";

import { documentInfoOf } from "./pdf-document-info";
import { openPdfObjects } from "./pdf-objects/document";

const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));

/** A PDF whose objects are `objects` (numbers 1…n), root 1, info 2 if given. The trailer carries /Info if `info`. */
function pdfWith(objects: Record<number, string>, info = false, header = "%PDF-1.4"): { bytes: Uint8Array } {
  const count = Math.max(...Object.keys(objects).map(Number));
  let file = `${header}\n`;
  const offsets: number[] = [];
  for (let n = 1; n <= count; n += 1) {
    offsets.push(file.length);
    file += `${n} 0 obj\n${objects[n] ?? "null"}\nendobj\n`;
  }
  const xrefAt = file.length;
  let table = `xref\n0 ${count + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  const trailer = `trailer\n<< /Size ${count + 1} /Root 1 0 R ${info ? "/Info 2 0 R" : ""} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return { bytes: enc(`${file}${table}${trailer}`) };
}

const infoOf = (made: { bytes: Uint8Array }) => {
  const doc = openPdfObjects(made.bytes);
  return documentInfoOf(doc, made.bytes);
};

describe("documentInfoOf: producer and creator", () => {
  it("reads Producer and Creator from the /Info dictionary, decoded as text strings", () => {
    const info = infoOf(
      pdfWith(
        {
          1: "<< /Type /Catalog /Pages 3 0 R >>",
          2: "<< /Producer (Acrobat) /Creator (Word) >>",
          3: "<< /Type /Pages /Kids [] /Count 0 >>",
        },
        true,
      ),
    );
    expect(info).toMatchObject({ producer: "Acrobat", creator: "Word" });
  });
});

describe("documentInfoOf: the format version (as pdf.js did: the catalog's /Version, otherwise the header)", () => {
  it("takes the header's version when the catalog declares none", () => {
    expect(infoOf(pdfWith({ 1: "<< /Type /Catalog >>" }, false, "%PDF-1.6"))).toMatchObject({ pdfVersion: "1.6" });
  });

  it("🔴 takes the catalog's /Version even when the header is OLDER (1.3 against 1.4, measured)", () => {
    expect(infoOf(pdfWith({ 1: "<< /Type /Catalog /Version /1.4 >>" }, false, "%PDF-1.3"))).toMatchObject({
      pdfVersion: "1.4",
    });
  });
});

describe("documentInfoOf: linearized", () => {
  it("🔴 is NOT linearized when /L does not match the file size (file modified afterwards)", () => {
    const made = pdfWith(
      { 1: "<< /Type /Catalog >>" },
      false,
      "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n137 0 obj\n<</Linearized 1 /L 999999 >>\nendobj",
    );
    expect(infoOf(made)).not.toHaveProperty("linearized");
  });

  it("is linearized when /L equals the real size, even if /L is not the first key", () => {
    // A VALID PDF (xref table and trailer), with a linearized leading object. /L has a fixed width: we fill it
    // once with a placeholder, measure the size, then write it with the exact value.
    const build = (length: string) =>
      pdfWith({
        1: "<< /Type /Catalog >>",
        3: `<< /Linearized 1 /H [1 2] /L ${length} >>`,
      }).bytes;
    const size = build("0000000").length;
    const bytes = build(String(size).padStart(7, "0"));
    expect(bytes.length).toBe(size);
    expect(infoOf({ bytes })).toMatchObject({ linearized: true });
  });
});

describe("documentInfoOf: form (as pdf.js did: fields, and not only invisible signatures)", () => {
  it("🔴 has NO form when its only fields are invisible signatures (SigFlags bit 1)", () => {
    const made = pdfWith({
      1: "<< /Type /Catalog /AcroForm << /Fields [3 0 R] /SigFlags 3 >> >>",
      3: "<< /FT /Sig /Rect [0 0 0 0] >>",
    });
    expect(infoOf(made)).not.toHaveProperty("form");
  });

  it("has one when there is a text field", () => {
    const made = pdfWith({
      1: "<< /Type /Catalog /AcroForm << /Fields [3 0 R] >> >>",
      3: "<< /FT /Tx /T (nom) /Rect [0 0 50 20] >>",
    });
    expect(infoOf(made)).toMatchObject({ form: true });
  });

  it("has none when /Fields is empty", () => {
    expect(infoOf(pdfWith({ 1: "<< /Type /Catalog /AcroForm << /Fields [] >> >>" }))).not.toHaveProperty("form");
  });
});
