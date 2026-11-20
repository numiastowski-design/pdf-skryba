/** The links read from our dictionary (`pdf-links-ours.ts`), rule by rule, as pdf.js applied them (removed since).
 *  The measurement that validates them: `tools/poc/links-shadow.ts` (deleted, see git history), 7,231 pages out of 7,231 in agreement with pdf.js. */
import { describe, expect, it } from "vitest";

import { absoluteTargetOf, linkAnnotationsOfPage } from "./pdf-links-ours";
import { openPdfObjects } from "./pdf-objects/document";

/** A page whose annotations are `annots` (objects 4, 5…), root 1, page 3. */
function pdfWithAnnots(annots: string[]): Uint8Array {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    `<< /Type /Page /Parent 2 0 R /Annots [${annots.map((_, i) => `${i + 4} 0 R`).join(" ")}] >>`,
    ...annots,
  ];
  let file = "%PDF-1.4\n";
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

/** A URI link with the given target and flags. */
const uriLink = (uri: string, extra = ""): string =>
  `<< /Type /Annot /Subtype /Link /Rect [10 20 110 40] ${extra} /A << /S /URI /URI (${uri}) >> >>`;

const linksOf = (annots: string[]) => {
  const doc = openPdfObjects(pdfWithAnnots(annots));
  return linkAnnotationsOfPage(doc, doc.pages()[0]!);
};

describe("absoluteTargetOf: la cible d'un lien, comme pdf.js la prend", () => {
  it("garde une cible absolue, et la normalise comme l'analyse WHATWG (barre finale ajoutée)", () => {
    expect(absoluteTargetOf("https://example.org")).toBe("https://example.org/");
  });

  it("ajoute http:// à un préfixe www. qui a au moins deux points", () => {
    expect(absoluteTargetOf("www.example.org")).toBe("http://www.example.org/");
  });

  it("n'ajoute RIEN à un www. qui n'a qu'un point : ce n'est pas un nom d'hôte", () => {
    expect(absoluteTargetOf("www.example")).toBeUndefined();
  });

  it("refuse un protocole que pdf.js ne garde pas", () => {
    expect(absoluteTargetOf("javascript:alert(1)")).toBeUndefined();
    expect(absoluteTargetOf("file:///etc/passwd")).toBeUndefined();
  });

  it("garde mailto, tel et ftp", () => {
    expect(absoluteTargetOf("mailto:a@example.org")).toBe("mailto:a@example.org");
    expect(absoluteTargetOf("tel:+33123")).toBe("tel:+33123");
    expect(absoluteTargetOf("ftp://ftp.example.org/x")).toBe("ftp://ftp.example.org/x");
  });

  it("refuse une cible relative : pdf.js la met dans unsafeUrl, pas dans url", () => {
    expect(absoluteTargetOf("/sitemap.xml")).toBeUndefined();
  });

  it("🔴 relit les octets en UTF-8, comme pdf.js : « à » encodé sur deux octets devient « à »", () => {
    // The bytes C3 A0 ("à" in UTF-8) read as latin1 give "Ã" + "NBSP"; re-read as UTF-8 they give "à" again.
    expect(absoluteTargetOf("https://e.org/Ã ")).toBe("https://e.org/%C3%A0");
  });

  it("laisse une chaîne qui n'est pas de l'UTF-8 valide telle quelle, comme pdf.js", () => {
    // A lone 0xFF is not UTF-8: pdf.js keeps the original string, which then encodes as latin1 percent.
    expect(absoluteTargetOf("https://e.org/ÿ")).toBe("https://e.org/%C3%BF");
  });
});

describe("linkAnnotationsOfPage: quels liens on garde", () => {
  it("garde un lien URI visible, avec son rectangle normalisé", () => {
    expect(linksOf([uriLink("https://example.org")])).toStrictEqual([
      { url: "https://example.org/", rect: [10, 20, 110, 40] },
    ]);
  });

  it("écarte une annotation qui n'est pas un lien", () => {
    expect(
      linksOf(["<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] /A << /S /URI /URI (https://x.org) >> >>"]),
    ).toStrictEqual([]);
  });

  it("écarte un lien qui n'est pas une action URI (un GoTo, par exemple)", () => {
    expect(linksOf(["<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /Dest [3 0 R /Fit] >>"])).toStrictEqual([]);
  });

  it("écarte un lien invisible (indicateur /F : Invisible, Hidden ou NoView)", () => {
    expect(linksOf([uriLink("https://x.org", "/F 1")])).toStrictEqual([]);
    expect(linksOf([uriLink("https://x.org", "/F 2")])).toStrictEqual([]);
    expect(linksOf([uriLink("https://x.org", "/F 32")])).toStrictEqual([]);
  });

  it("garde un lien dont l'indicateur /F ne masque rien (ex. /F 4, Print)", () => {
    expect(linksOf([uriLink("https://x.org", "/F 4")])).toHaveLength(1);
  });

  it("écarte une action qui s'ouvre dans une autre fenêtre (/NewWindow)", () => {
    const annot =
      "<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /URI /URI (https://x.org) /NewWindow true >> >>";
    expect(linksOf([annot])).toStrictEqual([]);
  });

  it("écarte un rectangle qui n'a pas quatre nombres finis", () => {
    expect(
      linksOf(["<< /Type /Annot /Subtype /Link /Rect [0 0 1] /A << /S /URI /URI (https://x.org) >> >>"]),
    ).toStrictEqual([]);
  });
});
