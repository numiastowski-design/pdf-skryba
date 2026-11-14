/** The fill colour of a device colour operator (ISO 32000-1:2008 §8.6.4.2: `g`, `rg`, `k`), as the table detector reads it:
 *  a `#rrggbb` string, the form the operator reader carries.
 *  Decides: the RGB bytes of a DeviceGray, DeviceRGB or DeviceCMYK colour. CMYK uses the polynomial of the Adobe-style
 *  approximation pdf.js used before its removal (`DeviceCmykCS` in its worker, kept for byte-identical output), with its coefficients written here: a linear
 *  conversion would paint the same black a different grey, and the swatch test compares colours.
 *  NOT here: the other colour spaces (ICCBased, Indexed, Separation, DeviceN, Pattern, CalRGB, Lab): a colour in those
 *  spaces is not converted, and the caller keeps the colour it had (a limit, written in `pdf-ops-ours.ts`).
 *  Called by: `extractor/pdf-ops-ours.ts`, `pdf-colour-ours.test.ts`. */

const byte = (value: number): string => {
  const clamped = Math.min(255, Math.max(0, Math.round(value)));
  return clamped.toString(16).padStart(2, "0");
};

/** A grey level in [0, 1] as the RGB hex string. */
export function greyHex(grey: number): string {
  const b = byte(grey * 255);
  return `#${b}${b}${b}`;
}

/** Red, green and blue in [0, 1] as the RGB hex string. */
export function rgbHex(red: number, green: number, blue: number): string {
  return `#${byte(red * 255)}${byte(green * 255)}${byte(blue * 255)}`;
}

/** Cyan, magenta, yellow and black in [0, 1] as the RGB hex string (the DeviceCMYK polynomial taken from pdf.js, bytes 0–255). */
export function cmykHex(cyan: number, magenta: number, yellow: number, black: number): string {
  const [red, green, blue] = cmykBytes(cyan, magenta, yellow, black);
  return `#${byte(red)}${byte(green)}${byte(blue)}`;
}

/** The same conversion as numbers: red, green, blue in [0, 255] (not rounded), for pixel loops. */
export function cmykBytes(cyan: number, magenta: number, yellow: number, black: number): [number, number, number] {
  const c = cyan;
  const m = magenta;
  const y = yellow;
  const k = black;
  const red =
    255 +
    c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k + -285.2331026137004) +
    m * (1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k - 5.497006427196366) +
    y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) +
    k * (-21.86122147463605 * k - 189.48180835922747);
  const green =
    255 +
    c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k + -79.2970844816548) +
    m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) +
    y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) +
    k * (-20.737325471181034 * k - 187.80453709719578);
  const blue =
    255 +
    c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k + -14.183576799673286) +
    m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) +
    y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505) +
    k * (-22.33816807309886 * k - 180.12613974708367);
  return [red, green, blue];
}
