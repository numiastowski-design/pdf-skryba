/** The expansion of Form XObjects is bounded PER PAGE, in the three readers that unroll them (security review of
 *  02/11/2026, finding 2). Depth was capped at 8 but the NUMBER of calls was not: a form that calls the next one a hundred
 *  times, eight levels down, is 10^16 expansions from a file of a few hundred bytes, each one re-reading a stream the document
 *  budget charges a handful of bytes for.
 *  The hostile file here is cheap: ten calls per form over five levels is 11 111 expansions, just over the ceiling, and a few
 *  hundred thousand operators when unguarded — slow enough to see, nowhere near enough to hurt the suite. */
import { describe, expect, it, vi } from "vitest";

const tokenized = vi.hoisted(() => ({ count: 0 }));
vi.mock("./pdf-objects/content", async (importActual) => {
  const actual = await importActual<typeof import("./pdf-objects/content")>();
  return {
    ...actual,
    readContentOps: (...args: Parameters<typeof actual.readContentOps>) => (
      (tokenized.count += 1),
      actual.readContentOps(...args)
    ),
  };
});

import { openOurGlyphs } from "./pdf-glyph-source";
import { ourFontNamesIn } from "./pdf-font-bridge";
import { openPdfObjects } from "./pdf-objects/document";
import { MAX_FORM_CALLS_PER_PAGE } from "./pdf-objects/bounds";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";
import { ourOpsOfPage } from "./pdf-ops-ours";
import { pageContentOf, parsedFormOf } from "./pdf-page-content";
import { documentCacheOf } from "./document-cache";

/** A one-page PDF whose page draws form 1, form k drawing form k+1 `fanOut` times, the last one drawing nothing. */
function pdfOfForms(levels: number, fanOut: number, leafBody = "q Q"): Uint8Array {
  const stream = (dict: string, body: string): string =>
    `<< ${dict} /Length ${body.length} >>\nstream\n${body}\nendstream`;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /XObject << /F 5 0 R >> >> >>",
    stream("", "/F Do"),
  ];
  for (let level = 1; level <= levels; level += 1) {
    const last = level === levels;
    const body = last ? leafBody : "/F Do ".repeat(fanOut).trim();
    const resources = last ? "" : `/Resources << /XObject << /F ${5 + level} 0 R >> >>`;
    objects.push(stream(`/Type /XObject /Subtype /Form /BBox [0 0 10 10] ${resources}`, body));
  }
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

const refusalOf = (run: () => unknown): PdfObjectsRefusal => {
  try {
    run();
  } catch (error) {
    if (error instanceof PdfObjectsRefusal) return error;
    throw error;
  }
  throw new Error("expected a refusal, got none");
};

describe("MAX_FORM_CALLS_PER_PAGE : les formulaires qui s'appellent les uns les autres sont bornés par page", () => {
  const hostile = pdfOfForms(5, 10);

  it("la valeur de départ tient entre le réel mesuré (16 appels sur 342 pages, 12 sur 55) et le fichier hostile (11 111)", () => {
    expect(MAX_FORM_CALLS_PER_PAGE).toBe(10_000);
    expect(MAX_FORM_CALLS_PER_PAGE).toBeGreaterThan(16);
    expect(MAX_FORM_CALLS_PER_PAGE).toBeLessThan(11_111);
  });

  it("les opérateurs d'une page : refusés (forms-too-many)", () => {
    const doc = openPdfObjects(hostile);
    expect(refusalOf(() => ourOpsOfPage(doc, doc.pages()[0]!)).reason).toBe("forms-too-many");
  });

  it("les glyphes d'une page : refusés (forms-too-many)", () => {
    expect(refusalOf(() => openOurGlyphs(hostile).glyphsOfPage(0)).reason).toBe("forms-too-many");
  });

  it("le pont des noms de police : refusé (forms-too-many)", () => {
    // The resolver hands back a form that draws ten more, five levels deep (the scope is the path of the form).
    const enc = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));
    const resolve = (name: string, scope: string) => {
      const depth = scope === "" ? 0 : scope.split("/").length;
      return {
        data: enc(depth >= 4 ? "/F1 12 Tf" : "/F Do ".repeat(10)),
        scope: scope === "" ? `form:${name}` : `${scope}/form:${name}`,
      };
    };
    expect(refusalOf(() => ourFontNamesIn(enc("/F Do"), resolve)).reason).toBe("forms-too-many");
  });

  it("un vrai document (16 appels de formulaire sur une page) n'est pas refusé", () => {
    const doc = openPdfObjects(pdfOfForms(2, 16));
    expect(() => ourOpsOfPage(doc, doc.pages()[0]!)).not.toThrow();
  });
});

describe("les opérateurs d'une page sont bornés PENDANT le déroulement des formulaires (revue de sécurité, tour 2, constat 8)", () => {
  it("🔴 un formulaire de 80 000 opérateurs dessiné 30 fois (2 400 000, loin des 10 000 appels) est refusé (content-too-long)", () => {
    const doc = openPdfObjects(pdfOfForms(2, 30, "q Q ".repeat(40_000).trim()));
    let longest = 0;
    const refusal = refusalOf(() => {
      const ops = ourOpsOfPage(doc, doc.pages()[0]!);
      longest = ops.length;
    });
    expect(refusal.reason).toBe("content-too-long");
    expect(longest, "aucune liste n'a été rendue").toBe(0);
  });
});

describe("un formulaire dessiné plusieurs fois est décodé une fois par page (revue de performance du 02/11/2026)", () => {
  it("🔴 un formulaire dessiné 50 fois : trois décodages (la page, le formulaire parent, le formulaire dessiné), pas cinquante-deux", () => {
    const doc = openPdfObjects(pdfOfForms(2, 50));
    let decodes = 0;
    const counting = {
      ...doc,
      streamBytes: (stream: Parameters<typeof doc.streamBytes>[0]) => {
        decodes += 1;
        return doc.streamBytes(stream);
      },
    };
    ourOpsOfPage(counting, doc.pages()[0]!);
    expect(decodes).toBeLessThanOrEqual(3);
  });
});

describe("le formulaire décodé est gardé pour le DOCUMENT, pas pour la page (contre-revue de performance du 02/11/2026)", () => {
  it("🔴 la même page lue deux fois ne décode ses formulaires qu'une fois en tout : 4 décodages (la page deux fois, deux formulaires une fois)", () => {
    const doc = openPdfObjects(pdfOfForms(2, 50));
    let decodes = 0;
    const counting = {
      ...doc,
      streamBytes: (stream: Parameters<typeof doc.streamBytes>[0]) => {
        decodes += 1;
        return doc.streamBytes(stream);
      },
    };
    ourOpsOfPage(counting, doc.pages()[0]!);
    ourOpsOfPage(counting, doc.pages()[0]!);
    expect(decodes).toBeLessThanOrEqual(4);
  });
});

describe("un formulaire est tokenisé une fois par document (revue de performance du 02/11/2026, finding 5)", () => {
  it("🔴 un formulaire dessiné 50 fois, la page lue deux fois : 4 tokenisations (la page deux fois, les deux formulaires une fois), pas 104", () => {
    const doc = openPdfObjects(pdfOfForms(2, 50));
    tokenized.count = 0;
    const first = ourOpsOfPage(doc, doc.pages()[0]!);
    const second = ourOpsOfPage(doc, doc.pages()[0]!);
    expect(second).toHaveLength(first.length);
    expect(tokenized.count).toBeLessThanOrEqual(4);
    expect(parsedFormOf(doc, formOf(doc, 5))).toBe(parsedFormOf(doc, formOf(doc, 5)));
  });
});

/** The form stream of object `num`. */
function formOf(doc: ReturnType<typeof openPdfObjects>, num: number) {
  const stream = doc.resolve({ kind: "ref", num, gen: 0 });
  if (stream?.kind !== "stream") throw new Error("not a stream");
  return stream;
}

describe("ce que le cache compte (contre-revue de performance du 02/11/2026)", () => {
  it("🔴 un formulaire hostile de 600 000 opérateurs (1,2 Mo, environ 66 Mo de tas à 110 octets l'un) dépasse le plafond et n'est pas gardé", () => {
    const doc = openPdfObjects(pdfOfForms(1, 1, "q Q ".repeat(300_000)));
    const form = formOf(doc, 5);
    const first = parsedFormOf(doc, form);
    expect(first).toHaveLength(600_000);
    expect(parsedFormOf(doc, form), "retokenisé : il n'a pas été gardé").not.toBe(first);
  });

  it("un formulaire ordinaire est gardé (le même tableau à la seconde demande)", () => {
    const doc = openPdfObjects(pdfOfForms(1, 1, "q Q"));
    const form = formOf(doc, 5);
    expect(parsedFormOf(doc, form)).toBe(parsedFormOf(doc, form));
  });

  it("🔴 le contenu d'une page à un seul flux sans filtre est une vue du fichier : il ne coûte rien au cache", () => {
    const doc = openPdfObjects(pdfOfForms(1, 1));
    pageContentOf(doc, doc.pages()[0]!);
    expect(documentCacheOf(doc).size).toBe(0);
  });
});

describe("ce que le cache compte, suite (dernier tour de revue de performance, 02/11/2026)", () => {
  it("🔴 les opérandes d'un formulaire se paient : 1 000 `cm` de six opérandes coûtent au moins leurs opérateurs et leurs nœuds", () => {
    const doc = openPdfObjects(pdfOfForms(1, 1, "1 0 0 1 5 5 cm ".repeat(1000)));
    parsedFormOf(doc, formOf(doc, 5));
    // 1 000 operators at 110 bytes and at least 6 000 operand nodes at 48: 398 000, and the bytes (a view of the file) are free.
    expect(documentCacheOf(doc).size).toBeGreaterThanOrEqual(1000 * 110 + 6000 * 48);
  });

  it("🔴 les octets d'un formulaire se paient même s'il est une vue du fichier : le tokenizer copie chaque chaîne", () => {
    const doc = openPdfObjects(pdfOfForms(1, 1, `(${"x".repeat(1_000_000)}) Tj`));
    parsedFormOf(doc, formOf(doc, 5));
    expect(documentCacheOf(doc).size, "une chaîne d'un million d'octets, copiée").toBeGreaterThanOrEqual(1_000_000);
  });
});
