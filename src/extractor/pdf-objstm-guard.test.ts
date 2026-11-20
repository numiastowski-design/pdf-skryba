/** The guard in front of `pdf-lib` on the scan path (`pdf-objstm-guard.ts`; security review of 02/11/2026, finding 9, the part that
 *  stays: `pdf-scanned.ts` opens the client's whole file with `pdf-lib` to slice pages out of it).
 *  `pdf-lib` inflates every object stream it meets in the body — referenced by the cross-reference table or not — with none of our
 *  bounds, so the guard reads the raw bytes, not the table. */
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { assertObjectStreamsBounded } from "./pdf-objstm-guard";
import { objectStreamSource } from "./pdf-objstm-source";
import { ocrScannedPages } from "./pdf-scanned";
import { MAX_DECODED_STREAM_BYTES } from "./pdf-objects/bounds";
import { PdfObjectsRefusal } from "./pdf-objects/refusal";

const text = (s: string): Buffer => Buffer.from(s, "latin1");

/** A one-page PDF with a classic table, plus one more object: a stream with the dictionary `dict`, holding `body`. */
function pdfWithStream(dict: string, body: Buffer, streamLine = "stream\n"): Uint8Array {
  const bodies: Buffer[] = [
    text("<< /Type /Catalog /Pages 2 0 R >>"),
    text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
    text("<< /Type /Page /Parent 2 0 R >>"),
    Buffer.concat([text(`<< ${dict} /Length ${body.length} >>\n${streamLine}`), body, text("\nendstream")]),
  ];
  const chunks: Buffer[] = [text("%PDF-1.5\n")];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  bodies.forEach((b, i) => {
    offsets.push(length);
    const object = Buffer.concat([text(`${i + 1} 0 obj\n`), b, text("\nendobj\n")]);
    chunks.push(object);
    length += object.length;
  });
  let table = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f\r\n`;
  for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
  chunks.push(text(`${table}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(chunks));
}

/** zlib of `inflated` spaces: a few tens of kilobytes for tens of megabytes. */
const bomb = (inflated: number): Buffer => Buffer.from(deflateSync(Buffer.alloc(inflated, 0x20)));

const refusalOf = async (run: () => Promise<unknown>): Promise<PdfObjectsRefusal | undefined> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof PdfObjectsRefusal) return error;
    throw error;
  }
  return undefined;
};

const OVER = MAX_DECODED_STREAM_BYTES + 1_000_000;

describe("assertObjectStreamsBounded : les flux d'objets d'un fichier, lus dans ses octets", () => {
  it("🔴 un flux d'objets qui dépasse le plafond d'un flux, que nulle table ne mentionne, est refusé (document-too-large)", async () => {
    const hostile = pdfWithStream("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", bomb(OVER));
    expect((await refusalOf(() => assertObjectStreamsBounded(hostile, objectStreamSource())))?.reason).toBe(
      "document-too-large",
    );
  });

  it("🔴 le nom écrit avec des échappements (/Obj#53tm) est reconnu comme /ObjStm", async () => {
    const hostile = pdfWithStream("/Type /Obj#53tm /N 1 /First 4 /Filter /FlateDecode", bomb(OVER));
    expect((await refusalOf(() => assertObjectStreamsBounded(hostile, objectStreamSource())))?.reason).toBe(
      "document-too-large",
    );
  });

  it("🔴 plusieurs flux d'objets, chacun sous le plafond d'un flux mais dépassant le budget du document, sont refusés", async () => {
    // Four streams of 60 MB each: under the 64 MB of one stream, 240 MB in all, over the 200 MB of the document.
    const one = bomb(60_000_000);
    const dict = "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode";
    const objects = [
      text("<< /Type /Catalog /Pages 2 0 R >>"),
      text("<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>"),
      text("<< /Type /Page /Parent 2 0 R >>"),
    ];
    for (let i = 0; i < 4; i += 1)
      objects.push(Buffer.concat([text(`<< ${dict} /Length ${one.length} >>\nstream\n`), one, text("\nendstream")]));
    const chunks: Buffer[] = [text("%PDF-1.5\n")];
    const offsets: number[] = [];
    let length = chunks[0]!.length;
    objects.forEach((b, i) => {
      offsets.push(length);
      const object = Buffer.concat([text(`${i + 1} 0 obj\n`), b, text("\nendobj\n")]);
      chunks.push(object);
      length += object.length;
    });
    let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f\r\n`;
    for (const offset of offsets) table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
    chunks.push(text(`${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
    expect(
      (await refusalOf(() => assertObjectStreamsBounded(new Uint8Array(Buffer.concat(chunks)), objectStreamSource())))
        ?.reason,
    ).toBe("document-too-large");
  }, 60_000);

  it("un flux d'objets ordinaire passe", async () => {
    const fine = pdfWithStream(
      "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode",
      Buffer.from(deflateSync(text("1 0 << /A 1 >>"))),
    );
    expect(await refusalOf(() => assertObjectStreamsBounded(fine, objectStreamSource()))).toBeUndefined();
  });

  it("un flux qui n'est pas un flux d'objets n'est pas décompressé, même énorme (une grosse image Flate d'un scan)", async () => {
    const image = pdfWithStream(
      "/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /FlateDecode",
      bomb(OVER),
    );
    const started = performance.now();
    expect(await refusalOf(() => assertObjectStreamsBounded(image, objectStreamSource()))).toBeUndefined();
    expect(performance.now() - started, "rien n'a été décompressé").toBeLessThan(300);
  });

  const hostileDicts: [string, string][] = [
    ["une clé en plus dont le nom finit par obj (/Zobj)", "/Zobj 1 /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode"],
    ["un (obj) dans une chaîne du dictionnaire", "/Title (obj) /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode"],
    ["un flux de références croisées (/XRef)", "/Type /XRef /W [1 1 1] /Size 1 /Filter /FlateDecode"],
    ["un /Type indirect (/Type 7 0 R)", "/Type 7 0 R /N 1 /First 4 /Filter /FlateDecode"],
    [
      "un en-tête de plus de 4 096 octets",
      `/Pad (${"x".repeat(10_000)}) /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode`,
    ],
  ];
  for (const [label, dict] of hostileDicts) {
    it(`🔴 ${label} ne cache pas la bombe`, async () => {
      expect(
        (await refusalOf(() => assertObjectStreamsBounded(pdfWithStream(dict, bomb(OVER)), objectStreamSource())))
          ?.reason,
      ).toBe("document-too-large");
    });
  }

  const round3: [string, string][] = [
    ["le mot stream dans une chaîne du dictionnaire", "/X (stream) /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode"],
    ["le mot endobj dans une chaîne du dictionnaire", "/X (endobj) /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode"],
    ["un /Type écrit sans espace avant le R (/Type 7 0R)", "/Type 7 0R /N 1 /First 4 /Filter /FlateDecode"],
  ];
  for (const [label, dict] of round3) {
    it(`🔴 ${label} ne cache pas la bombe`, async () => {
      expect(
        (await refusalOf(() => assertObjectStreamsBounded(pdfWithStream(dict, bomb(OVER)), objectStreamSource())))
          ?.reason,
      ).toBe("document-too-large");
    });
  }

  it("🔴 un en-tête d'objet écrit avec des NUL entre les jetons ne cache pas la bombe", async () => {
    const plain = Buffer.from(pdfWithStream("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", bomb(OVER))).toString(
      "latin1",
    );
    const nul = String.fromCharCode(0);
    const hostile = new Uint8Array(Buffer.from(plain.replace("4 0 obj", `4${nul}0${nul}obj`), "latin1"));
    expect((await refusalOf(() => assertObjectStreamsBounded(hostile, objectStreamSource())))?.reason).toBe(
      "document-too-large",
    );
  });

  it("🔴 un /Filter indirect (/Filter 9 0 R) est refusé : on ne sait pas le compter", async () => {
    const hostile = pdfWithStream("/Type /ObjStm /N 1 /First 4 /Filter 9 0 R", bomb(1000));
    expect((await refusalOf(() => assertObjectStreamsBounded(hostile, objectStreamSource())))?.reason).toBe(
      "filter-unsupported",
    );
  });

  it("🔴 le mot-clé stream suivi d'un retour chariot seul, ou d'espaces puis CRLF, ne cache pas la bombe", async () => {
    const dict = "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode";
    const cr = String.fromCharCode(13);
    const lf = String.fromCharCode(10);
    for (const line of [`stream${cr}`, `stream  ${cr}${lf}`]) {
      expect(
        (await refusalOf(() => assertObjectStreamsBounded(pdfWithStream(dict, bomb(OVER), line), objectStreamSource())))
          ?.reason,
      ).toBe("document-too-large");
    }
  });

  it("🔴 une chaîne de filtres (ASCIIHex puis Flate) est refusée : on ne sait pas la compter", async () => {
    const hostile = pdfWithStream("/Type /ObjStm /N 1 /First 4 /Filter [/ASCIIHexDecode /FlateDecode]", bomb(1000));
    expect((await refusalOf(() => assertObjectStreamsBounded(hostile, objectStreamSource())))?.reason).toBe(
      "filter-unsupported",
    );
  });

  it("🔴 une somme de contrôle corrompue ne cache pas la bombe (l'erreur compte ce qui a été décompressé)", async () => {
    const broken = bomb(OVER);
    broken[broken.length - 1] = broken[broken.length - 1]! ^ 0xff;
    const hostile = pdfWithStream("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", broken);
    expect((await refusalOf(() => assertObjectStreamsBounded(hostile, objectStreamSource())))?.reason).toBe(
      "document-too-large",
    );
  });

  it("🔴 un fichier chiffré : le garde compte les octets déchiffrés par notre lecteur, pas le chiffré", async () => {
    // The file's own bytes are noise (what a ciphertext looks like); the reader hands the real stream.
    const noise = Buffer.alloc(2000, 0x41);
    const encrypted = pdfWithStream("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", noise);
    const stream = { kind: "stream" };
    const doc = {
      trailer: () => new Map([["Encrypt", {}]]),
      resolve: () => stream,
      rawStreamBytes: () => new Uint8Array(bomb(OVER)),
    } as never;
    expect((await refusalOf(() => assertObjectStreamsBounded(encrypted, objectStreamSource(doc))))?.reason).toBe(
      "document-too-large",
    );
  });

  it("🔴 un fichier de 50 000 en-têtes sans flux se lit en temps linéaire (pas une analyse quadratique)", async () => {
    const lf = String.fromCharCode(10);
    const unit = "2 0 obj << /B 2 >> endobj" + lf;
    const last = "9 0 obj << /Type /XObject >>" + lf + "stream" + lf + "abc" + lf + "endstream" + lf + "endobj" + lf;
    const many = Buffer.from("%PDF-1.5" + lf + unit.repeat(50_000) + last, "latin1");
    const started = performance.now();
    expect(
      await refusalOf(() => assertObjectStreamsBounded(new Uint8Array(many), objectStreamSource())),
    ).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("🔴 la lecture IA d'un scan refuse le fichier AVANT de le donner à pdf-lib, et n'appelle pas l'IA", async () => {
    let calls = 0;
    const vision = {
      analyzeDocument: async () => {
        calls += 1;
        return [];
      },
    } as never;
    const hostile = pdfWithStream("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", bomb(OVER));
    expect((await refusalOf(() => ocrScannedPages(hostile, [0], vision)))?.reason).toBe("document-too-large");
    expect(calls).toBe(0);
  });
});

describe("assertObjectStreamsBounded : tour 4 de la revue de sécurité", () => {
  const dict = "/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode";

  it("🔴 un commentaire entre >> et stream ne cache pas la bombe", async () => {
    const lf = String.fromCharCode(10);
    const hostile = pdfWithStream(dict, bomb(OVER), `%c${lf}stream${lf}`);
    // The builder writes `>>` + newline + line: the comment line sits between them.
    expect((await refusalOf(() => assertObjectStreamsBounded(hostile, objectStreamSource())))?.reason).toBe(
      "document-too-large",
    );
  });

  it("🔴 le mot stream sans fin de ligne derrière est refusé (on ne sait pas si c'est un mot-clé)", async () => {
    const hostile = pdfWithStream(dict, bomb(OVER), "stream");
    expect((await refusalOf(() => assertObjectStreamsBounded(hostile, objectStreamSource())))?.reason).toBe(
      "filter-unsupported",
    );
  });

  it("🔴 un endstream littéral dans les données, avec une /Length exacte, ne tronque pas ce que le garde compte", async () => {
    // A stored (uncompressed) deflate block holding the word, then the bomb as a second stream of blocks: one valid zlib stream.
    const zlib = await import("node:zlib");
    const word = Buffer.from("endstream", "latin1");
    const stored = Buffer.concat([Buffer.from([0x00, word.length, 0x00, ~word.length & 0xff, 0xff]), word]); // BFINAL=0, BTYPE=00
    const rest = zlib.deflateRawSync(Buffer.alloc(OVER, 0x20));
    const body = Buffer.concat([Buffer.from([0x78, 0x01]), stored, rest, Buffer.alloc(4)]); // checksum is wrong: the count survives it
    const hostile = pdfWithStream(dict, body);
    expect((await refusalOf(() => assertObjectStreamsBounded(hostile, objectStreamSource())))?.reason).toBe(
      "document-too-large",
    );
  });

  it("🔴 un fichier ordinaire (une police /Subtype /Type1 devant une image Flate énorme) n'est pas refusé à tort", async () => {
    const lf = String.fromCharCode(10);
    const font = `9 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj${lf}`;
    const image = pdfWithStream(
      "/Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /FlateDecode",
      bomb(OVER),
    );
    const file = new Uint8Array(Buffer.concat([Buffer.from(font, "latin1"), Buffer.from(image)]));
    expect(await refusalOf(() => assertObjectStreamsBounded(file, objectStreamSource()))).toBeUndefined();
  });
});

describe("assertObjectStreamsBounded : le garde lui-même se lit en temps linéaire (revue de performance du 02/11/2026)", () => {
  const timed = async (file: Buffer): Promise<number> => {
    const started = performance.now();
    await refusalOf(() => assertObjectStreamsBounded(new Uint8Array(file), objectStreamSource()));
    return performance.now() - started;
  };

  it("🔴 240 Ko de >>% sans fin de ligne ne bloquent pas la lecture (11,8 s avec l'expression régulière)", async () => {
    expect(await timed(Buffer.from(">>%".repeat(80_000), "latin1"))).toBeLessThan(1000);
  });

  it("🔴 une suite de 200 000 chiffres dans un fichier chiffré ne bloque pas la lecture des en-têtes", async () => {
    const digits = "1".repeat(200_000);
    const lf = String.fromCharCode(10);
    const file = Buffer.from(
      `${digits}${lf}<< /Type /ObjStm /Filter /FlateDecode >>${lf}stream${lf}x${lf}endstream`,
      "latin1",
    );
    const doc = {
      trailer: () => new Map([["Encrypt", {}]]),
      resolve: () => undefined,
      rawStreamBytes: () => new Uint8Array(),
    } as never;
    const started = performance.now();
    await refusalOf(() => assertObjectStreamsBounded(new Uint8Array(file), objectStreamSource(doc)));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("🔴 mille /Filter [ sans ] ne bloquent pas la lecture", async () => {
    const lf = String.fromCharCode(10);
    const file = Buffer.from(
      `<< /Type /ObjStm ${"/Filter [ ".repeat(20_000)} >>${lf}stream${lf}x${lf}endstream`,
      "latin1",
    );
    expect(await timed(file)).toBeLessThan(1000);
  });
});

describe("assertObjectStreamsBounded : contre-revue de performance du 02/11/2026", () => {
  it("🔴 un dictionnaire qui finit par une chaîne hexadécimale (<00>>>) ne cache pas la bombe", async () => {
    // The builder writes `/Length n >>` after the dictionary: move the length ahead of a final hex string, so the dictionary ends `<00>>>`.
    const plain = Buffer.from(
      pdfWithStream("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Y <00", bomb(OVER)),
    ).toString("latin1");
    const at = plain.indexOf("<00 /Length ");
    const close = plain.indexOf(" >>", at);
    const length = plain.slice(at + "<00 /Length ".length, close);
    const hostile = new Uint8Array(
      Buffer.from(`${plain.slice(0, at)}/Length ${length} /X <00>>>${plain.slice(close + 3)}`, "latin1"),
    );
    expect(plain.includes("<00>>>")).toBe(false);
    expect(Buffer.from(hostile).toString("latin1")).toContain("<00>>>");
    expect((await refusalOf(() => assertObjectStreamsBounded(hostile, objectStreamSource())))?.reason).toBe(
      "document-too-large",
    );
  });
});
