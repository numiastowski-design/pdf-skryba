import { PDFDocument, PDFName, PDFRawStream } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";
import { openEmbeddedImages, unfilterPngRows } from "./pdf-embedded-images";
import { encryptedPdf } from "./pdf-password-protected.test.support";

describe("openEmbeddedImages", () => {
  it("un prédicteur PNG (DecodeParms Predictor 15) est défait", async () => {
    const pdf = await PDFDocument.create();
    const filtered = Uint8Array.from([1, 10, 20, 30, 5, 5, 5]); // 2x1 RVB, filtre Sub
    const ref = pdf.context.register(
      pdf.context.flateStream(filtered, {
        Type: "XObject",
        Subtype: "Image",
        Width: 2,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: "DeviceRGB",
        DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 2 },
      }),
    );
    const read = await openEmbeddedImages(await pdf.save());
    expect(read(`${ref.objectNumber}R`)?.mimeType).toBe("image/png");
  });

  it("ÉCHOUE FERMÉ : ref inconnu, palette indexée, masque d'image", async () => {
    const pdf = await PDFDocument.create();
    const indexed = pdf.context.register(
      pdf.context.flateStream(new Uint8Array([0, 1]), {
        Type: "XObject",
        Subtype: "Image",
        Width: 2,
        Height: 1,
        BitsPerComponent: 8,
        ColorSpace: [PDFName.of("Indexed"), PDFName.of("DeviceRGB"), 1, pdf.context.obj([])],
      }),
    );
    const mask = pdf.context.register(
      pdf.context.flateStream(new Uint8Array([0]), {
        Type: "XObject",
        Subtype: "Image",
        Width: 8,
        Height: 1,
        BitsPerComponent: 1,
        ImageMask: true,
      }),
    );
    const read = await openEmbeddedImages(await pdf.save());
    expect(read("99999R")).toBeUndefined();
    expect(read(`${indexed.objectNumber}R`)).toBeUndefined();
    expect(read(`${mask.objectNumber}R`)).toBeUndefined();
  });
});

describe("unfilterPngRows", () => {
  it("défait les cinq filtres PNG", () => {
    // Largeur 1, 1 canal, 5 lignes : valeurs 10..14, filtres 0 à 4.
    // Up : 1 + 11 = 12 ; Average : 7 + floor((0 + 12) / 2) = 13 ; Paeth (a=0, b=13, c=0 → 13) : 1 + 13 = 14.
    const data = Uint8Array.from([0, 10, 1, 11, 2, 1, 3, 7, 4, 1]);
    expect([...unfilterPngRows(data, 1, 5, 1)!]).toEqual([10, 11, 12, 13, 14]);
  });

  it("refuse un type de filtre inconnu", () => {
    expect(unfilterPngRows(Uint8Array.from([9, 1]), 1, 1, 1)).toBeUndefined();
  });
});

/** 🔴 A REGRESSION LIVED THROUGH, 15/09 → 17/09/2026, found on a real document.
 *
 *  This module opens the PDF with `ignoreEncryption: true`. That flag tells `pdf-lib` "do not refuse to open an
 *  encrypted document" — it does NOT say "decrypt it", and `pdf-lib` does not decrypt. On an encrypted PDF, the
 *  `/DCTDecode` stream handed back as it stands is therefore CIPHERTEXT, which we labelled `image/jpeg`.
 *
 *  In production: the four encrypted documents of one connection failed, the vision service answering "Unable to
 *  process input image" on bytes that had never been an image. No test could catch it: the corpus held no encrypted
 *  PDF. The witness here is the made-up one (`fixtures/pdf/59-Document-Chiffre-RC4.pdf`); the real ones are held by
 *  the application's tests.
 *
 *  The guard is general on purpose and does not speak of encryption: bytes whose DECLARED TYPE does not match their
 *  content are never delivered. The comment of 15/09 said "identical to the original" — nobody had checked that the
 *  stream WAS a JPEG, it was assumed. */
describe("un flux qui n'est pas ce qu'il prétend", () => {
  it("🔴 sur un PDF chiffré, aucune image n'est rendue avec un type qui ment", async () => {
    const read = await openEmbeddedImages(encryptedPdf());
    const lib = await PDFDocument.load(encryptedPdf(), { ignoreEncryption: true });

    let vus = 0;
    for (const [ref, obj] of lib.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      if (obj.dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
      vus++;
      const image = read(`${ref.objectNumber}R`);
      if (image === undefined) continue; // abstention : le comportement voulu
      const tete = Buffer.from(image.bytes.slice(0, 4)).toString("hex");
      if (image.mimeType === "image/jpeg") expect(tete.startsWith("ffd8ff"), `objet ${ref.objectNumber}`).toBe(true);
      if (image.mimeType === "image/png") expect(tete).toBe("89504e47");
    }
    expect(vus, "aucune image trouvée dans le PDF chiffré — le test ne prouverait rien").toBeGreaterThan(0);
  });
});
