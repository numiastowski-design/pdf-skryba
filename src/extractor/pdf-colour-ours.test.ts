/** Device colours as the `#rrggbb` string the table detector reads (`pdf-colour-ours.ts`). The black CMYK value follows from
 *  the polynomial by hand: red 43.66, green 46.46, blue 52.54, rounded to 44, 46, 53. */
import { describe, expect, it } from "vitest";

import { cmykHex, greyHex, rgbHex } from "./pdf-colour-ours";

describe("the fill colours of the device spaces", () => {
  it("grey: a value from 0 to 1 becomes the three equal bytes", () => {
    expect(greyHex(0)).toBe("#000000");
    expect(greyHex(1)).toBe("#ffffff");
    expect(greyHex(0.5)).toBe("#808080");
  });

  it("RGB: each component becomes one byte", () => {
    expect(rgbHex(1, 0, 0)).toBe("#ff0000");
    expect(rgbHex(0, 0.5, 1)).toBe("#0080ff");
  });

  it("CMYK: solid black follows the polynomial taken from pdf.js", () => {
    expect(cmykHex(0, 0, 0, 1)).toBe("#2c2e35");
  });

  it("CMYK: no ink is white", () => {
    expect(cmykHex(0, 0, 0, 0)).toBe("#ffffff");
  });
});
