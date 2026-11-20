/** Device colours as the `#rrggbb` string the table detector reads (`pdf-colour-ours.ts`). The black CMYK value follows from
 *  the polynomial by hand: red 43.66, green 46.46, blue 52.54, rounded to 44, 46, 53. */
import { describe, expect, it } from "vitest";

import { cmykHex, greyHex, rgbHex } from "./pdf-colour-ours";

describe("les couleurs de remplissage des espaces de périphérique", () => {
  it("gris : une valeur de 0 à 1 devient les trois octets égaux", () => {
    expect(greyHex(0)).toBe("#000000");
    expect(greyHex(1)).toBe("#ffffff");
    expect(greyHex(0.5)).toBe("#808080");
  });

  it("RVB : chaque composante devient un octet", () => {
    expect(rgbHex(1, 0, 0)).toBe("#ff0000");
    expect(rgbHex(0, 0.5, 1)).toBe("#0080ff");
  });

  it("CMJN : le noir plein suit le polynôme de pdf.js", () => {
    expect(cmykHex(0, 0, 0, 1)).toBe("#2c2e35");
  });

  it("CMJN : l'absence d'encre est blanche", () => {
    expect(cmykHex(0, 0, 0, 0)).toBe("#ffffff");
  });
});
