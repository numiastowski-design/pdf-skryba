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

describe("documentInfoOf: producteur et créateur", () => {
  it("lit Producer et Creator du dictionnaire /Info, décodés comme des chaînes de texte", () => {
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

describe("documentInfoOf: la version du format (comme pdf.js : /Version du catalogue, sinon l'en-tête)", () => {
  it("prend la version de l'en-tête quand le catalogue n'en déclare pas", () => {
    expect(infoOf(pdfWith({ 1: "<< /Type /Catalog >>" }, false, "%PDF-1.6"))).toMatchObject({ pdfVersion: "1.6" });
  });

  it("🔴 prend /Version du catalogue même quand il est PLUS ANCIEN que l'en-tête (1.3 contre 1.4 mesuré)", () => {
    expect(infoOf(pdfWith({ 1: "<< /Type /Catalog /Version /1.4 >>" }, false, "%PDF-1.3"))).toMatchObject({
      pdfVersion: "1.4",
    });
  });
});

describe("documentInfoOf: linéarisé", () => {
  it("🔴 n'est PAS linéarisé quand /L ne correspond pas à la taille du fichier (fichier modifié après coup)", () => {
    const made = pdfWith(
      { 1: "<< /Type /Catalog >>" },
      false,
      "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n137 0 obj\n<</Linearized 1 /L 999999 >>\nendobj",
    );
    expect(infoOf(made)).not.toHaveProperty("linearized");
  });

  it("l'est quand /L égale la taille réelle, même si /L n'est pas la première clé", () => {
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

describe("documentInfoOf: formulaire (comme pdf.js : des champs, et pas seulement des signatures invisibles)", () => {
  it("🔴 n'a PAS de formulaire quand ses seuls champs sont des signatures invisibles (SigFlags bit 1)", () => {
    const made = pdfWith({
      1: "<< /Type /Catalog /AcroForm << /Fields [3 0 R] /SigFlags 3 >> >>",
      3: "<< /FT /Sig /Rect [0 0 0 0] >>",
    });
    expect(infoOf(made)).not.toHaveProperty("form");
  });

  it("en a un quand il y a un champ de texte", () => {
    const made = pdfWith({
      1: "<< /Type /Catalog /AcroForm << /Fields [3 0 R] >> >>",
      3: "<< /FT /Tx /T (nom) /Rect [0 0 50 20] >>",
    });
    expect(infoOf(made)).toMatchObject({ form: true });
  });

  it("n'en a pas quand /Fields est vide", () => {
    expect(infoOf(pdfWith({ 1: "<< /Type /Catalog /AcroForm << /Fields [] >> >>" }))).not.toHaveProperty("form");
  });
});
