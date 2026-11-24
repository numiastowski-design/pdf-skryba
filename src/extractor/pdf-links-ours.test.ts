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

describe("absoluteTargetOf: the target of a link, as pdf.js took it", () => {
  it("keeps an absolute target, and normalises it as WHATWG parsing does (trailing slash added)", () => {
    expect(absoluteTargetOf("https://example.org")).toBe("https://example.org/");
  });

  it("adds http:// to a www. prefix that has at least two dots", () => {
    expect(absoluteTargetOf("www.example.org")).toBe("http://www.example.org/");
  });

  it("adds NOTHING to a www. with only one dot: it is not a host name", () => {
    expect(absoluteTargetOf("www.example")).toBeUndefined();
  });

  it("refuses a protocol that pdf.js did not keep", () => {
    expect(absoluteTargetOf("javascript:alert(1)")).toBeUndefined();
    expect(absoluteTargetOf("file:///etc/passwd")).toBeUndefined();
  });

  it("keeps mailto, tel and ftp", () => {
    expect(absoluteTargetOf("mailto:a@example.org")).toBe("mailto:a@example.org");
    expect(absoluteTargetOf("tel:+33123")).toBe("tel:+33123");
    expect(absoluteTargetOf("ftp://ftp.example.org/x")).toBe("ftp://ftp.example.org/x");
  });

  it("refuses a relative target: pdf.js put it in unsafeUrl, not in url", () => {
    expect(absoluteTargetOf("/sitemap.xml")).toBeUndefined();
  });

  it("🔴 re-reads the bytes as UTF-8, as pdf.js did: « à » encoded on two bytes becomes « à »", () => {
    // The bytes C3 A0 ("à" in UTF-8) read as latin1 give "Ã" + "NBSP"; re-read as UTF-8 they give "à" again.
    expect(absoluteTargetOf("https://e.org/Ã ")).toBe("https://e.org/%C3%A0");
  });

  it("leaves a string that is not valid UTF-8 as it is, as pdf.js did", () => {
    // A lone 0xFF is not UTF-8: pdf.js kept the original string, which then encodes as latin1 percent.
    expect(absoluteTargetOf("https://e.org/ÿ")).toBe("https://e.org/%C3%BF");
  });
});

describe("linkAnnotationsOfPage: which links are kept", () => {
  it("keeps a visible URI link, with its normalised rectangle", () => {
    expect(linksOf([uriLink("https://example.org")])).toStrictEqual([
      { url: "https://example.org/", rect: [10, 20, 110, 40] },
    ]);
  });

  it("drops an annotation that is not a link", () => {
    expect(
      linksOf(["<< /Type /Annot /Subtype /Text /Rect [0 0 1 1] /A << /S /URI /URI (https://x.org) >> >>"]),
    ).toStrictEqual([]);
  });

  it("drops a link that is not a URI action (a GoTo, for example)", () => {
    expect(linksOf(["<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /Dest [3 0 R /Fit] >>"])).toStrictEqual([]);
  });

  it("drops an invisible link (/F flag: Invisible, Hidden or NoView)", () => {
    expect(linksOf([uriLink("https://x.org", "/F 1")])).toStrictEqual([]);
    expect(linksOf([uriLink("https://x.org", "/F 2")])).toStrictEqual([]);
    expect(linksOf([uriLink("https://x.org", "/F 32")])).toStrictEqual([]);
  });

  it("keeps a link whose /F flag hides nothing (e.g. /F 4, Print)", () => {
    expect(linksOf([uriLink("https://x.org", "/F 4")])).toHaveLength(1);
  });

  it("drops an action that opens in another window (/NewWindow)", () => {
    const annot =
      "<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /A << /S /URI /URI (https://x.org) /NewWindow true >> >>";
    expect(linksOf([annot])).toStrictEqual([]);
  });

  it("drops a rectangle that does not have four finite numbers", () => {
    expect(
      linksOf(["<< /Type /Annot /Subtype /Link /Rect [0 0 1] /A << /S /URI /URI (https://x.org) >> >>"]),
    ).toStrictEqual([]);
  });
});
