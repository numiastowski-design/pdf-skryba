/** The text strings of a PDF (ISO 32000-1:2008 §7.9.2.2): UTF-16BE when they start with FE FF,
 *  PDFDocEncoding otherwise. Motivated on 31/10/2026: the title of a bookmark of `26-Livret-Accueil-Canva.pdf` is
 *  `D\x90ACCUEIL`, and our latin1 reading made it « DACCUEIL » where the standard says « D’ACCUEIL ». */
import { describe, expect, it } from "vitest";

import { decodePdfTextString } from "./pdf-text-string";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
/** A UTF-16BE string, BOM included. */
const utf16 = (text: string): Uint8Array => {
  const out = [0xfe, 0xff];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    out.push(unit >> 8, unit & 0xff);
  }
  return Uint8Array.from(out);
};

describe("decodePdfTextString: PDFDocEncoding (§7.9.2.2, Annexe D — table lue de la norme)", () => {
  it("🔴 rend 0x90 comme U+2019 (apostrophe typographique), et non le caractère de contrôle latin1", () => {
    // The real title of `26-Livret-Accueil-Canva.pdf`: « D » 0x90 « ACCUEIL ».
    expect(decodePdfTextString(bytes(0x44, 0x90, 0x41))).toBe("D’A");
  });

  it("garde l'ASCII imprimable tel quel", () => {
    expect(decodePdfTextString(bytes(0x41, 0x42, 0x20, 0x43))).toBe("AB C");
  });

  it("garde le latin-1 au-dessus de 0xA1 : la table ne le redéfinit pas", () => {
    expect(decodePdfTextString(bytes(0xe9))).toBe("é");
  });

  it("rend 0xA0 comme l'euro, comme la norme le donne", () => {
    expect(decodePdfTextString(bytes(0xa0))).toBe("€");
  });

  it("rend les accents de 0x18 à 0x1F (breve, caron, ring…) comme la norme", () => {
    expect(decodePdfTextString(bytes(0x18, 0x1f))).toBe("˘˜");
  });

  it("s'abstient sur un code que la norme ne définit pas : ni invention, ni caractère de contrôle", () => {
    // 0x00–0x17, 0x7F and 0x9F are not defined by the table; nothing is published for them.
    expect(decodePdfTextString(bytes(0x41, 0x00, 0x42, 0x9f, 0x43))).toBe("ABC");
  });
});

describe("decodePdfTextString: UTF-16BE quand le BOM FE FF est là", () => {
  it("décode un texte à BOM", () => {
    expect(decodePdfTextString(utf16("Chapitre 1"))).toBe("Chapitre 1");
  });

  it("recompose une paire de substitution en un seul caractère", () => {
    // U+1F600 = D83D DE00.
    expect(decodePdfTextString(bytes(0xfe, 0xff, 0xd8, 0x3d, 0xde, 0x00))).toBe("\u{1F600}");
  });

  it("écarte une moitié de paire isolée au lieu de la publier", () => {
    expect(decodePdfTextString(bytes(0xfe, 0xff, 0xd8, 0x3d, 0x00, 0x41))).toBe("A");
  });

  it("écarte U+0000, qui n'est pas du contenu", () => {
    expect(decodePdfTextString(bytes(0xfe, 0xff, 0x00, 0x00, 0x00, 0x41))).toBe("A");
  });
});

describe("decodePdfTextString: des octets vides ou mal formés ne lèvent pas", () => {
  it("rend une chaîne vide pour rien", () => {
    expect(decodePdfTextString(bytes())).toBe("");
  });

  it("ignore l'octet final d'un BOM UTF-16 de longueur impaire", () => {
    expect(decodePdfTextString(bytes(0xfe, 0xff, 0x00, 0x41, 0x00))).toBe("A");
  });
});
