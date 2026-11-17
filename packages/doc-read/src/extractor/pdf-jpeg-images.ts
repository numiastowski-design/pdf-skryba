/** The JPEG image XObject (`DCTDecode`) of a page, as the object the image reader takes (`pdf-images.ts`): width,
 *  height, kind, data. Decided here: a JPEG whose colour space we decode (DeviceRGB, DeviceGray, DeviceCMYK, ICCBased
 *  N = 3 or 1), with an optional soft mask (`pdf-smask.ts`: the picture is then RGBA). Refused, and reported as unreadable: a
 *  stencil `/Mask`, a soft mask we do not read, an unknown colour space, a component count that differs from the JPEG's.
 *  The pixels are decoded lazily, on first read (`pdf-image-pixels.ts`). NOT here: the placement, the PNG (`png.ts`).
 *  Called by: `extractor/pdf-source.ts` (ahead of the other image decoders), `pdf-jpeg-images.test.ts`. */

import { imageFilterOf } from "./pdf-objects/document";
import type { PdfObjectsDocument } from "./pdf-objects/document";
import type { PdfDict, PdfStream } from "./pdf-objects/objects";
import type { PictureScope } from "./pdf-image-pixels";
import type { DecodedImageObject } from "./pdf-ccitt-images";
import { alphaOf, maskSupported } from "./pdf-smask";
import {
  objectRefOf,
  componentsOfSpace,
  decodeArrayOf,
  entryOf,
  jpegFrameOf,
  nameOf,
  numberOf,
  pictureSizeOk,
  withDecode,
  cmykToRgb,
  rgbOf,
} from "./pdf-image-pixels";

type Decodes = readonly (readonly [number, number])[] | undefined;

/** What a JPEG image dictionary declares once checked: its soft mask (if any), its component count, its `/Decode` and size. */
interface JpegDeclared {
  readonly maskStream: PdfStream | undefined;
  readonly spaceComponents: number;
  readonly decodes: Decodes;
  readonly width: number;
  readonly height: number;
}

/** The dictionary's declarations, or `undefined` when the picture is one this reader does not read (pdf.js, which took those, is removed). */
function jpegDeclaredOf(doc: PdfObjectsDocument, dict: PdfDict): JpegDeclared | undefined {
  if (nameOf(doc.resolve(dict.get("Subtype"))) !== "Image") return undefined;
  // `imageFilterOf` and not `singleFilterOf`: the JPEG may be the LAST filter of a chain, a producer having compressed
  // it again (`/Filter [/FlateDecode /DCTDecode]`, measured on `46-GrandSoissons-CRACL`, page 12). The stream reader
  // undoes what comes before it (`imageStreamOf`), and we get the JPEG.
  if (imageFilterOf(doc, dict) !== "DCTDecode") return undefined;
  // A stencil `/Mask` is not ours yet: the picture is not read here. By its VALUE (`entryOf`): a dead reference is
  // not a mask, and reading it by presence lost a readable picture (security review of 03/11/2026).
  if (entryOf(doc, dict, "Mask") !== undefined) return undefined;
  // A soft mask (`/SMask`) is ours when it is an 8-bit grey image, Flate or DCT (`maskSupported`): the picture is then RGBA.
  const smask = entryOf(doc, dict, "SMask");
  const maskStream = smask?.kind === "stream" ? smask : undefined;
  if (smask !== undefined && (maskStream === undefined || !maskSupported(doc, maskStream))) return undefined;
  const spaceComponents = componentsOfSpace(doc, doc.resolve(dict.get("ColorSpace")));
  if (spaceComponents === undefined) return undefined;
  const decodes = decodeArrayOf(doc, dict, spaceComponents);
  if (decodes === null) return undefined;
  const width = numberOf(doc.resolve(dict.get("Width")));
  const height = numberOf(doc.resolve(dict.get("Height")));
  // The picture is resampled to this size when it is read, so it is bounded now (security review of 02/11/2026).
  if (width === undefined || height === undefined || !pictureSizeOk(width, height)) return undefined;
  return { maskStream, spaceComponents, decodes, width, height };
}

/** The JPEG itself: decrypted when the file is encrypted, and the non-image filters of the chain undone, nothing more
 *  (`imageStreamOf`). A holder we cannot name, or a refusal of the reader, leaves the image unread here. */
function rawBytesOf(doc: PdfObjectsDocument, stream: PdfStream): Uint8Array | undefined {
  try {
    return doc.imageStreamOf(stream).data;
  } catch {
    return undefined;
  }
}

/** The JPEG image `name` of the page, as an object the image reader takes (RGB, 24 bits), or `undefined` when not decoded here. */
export function jpegImageObjectOf(
  doc: PdfObjectsDocument,
  scope: PictureScope,
  name: string,
  kinds: { rgb: number; rgba: number },
): DecodedImageObject | undefined {
  const xobjects = doc.dictOf(scope.resources?.get("XObject"));
  const declared = xobjects?.get(name);
  const stream = doc.resolve(declared);
  if (stream?.kind !== "stream") return undefined;
  const found = jpegDeclaredOf(doc, stream.dict);
  if (found === undefined) return undefined;
  const { maskStream, spaceComponents, decodes, width, height } = found;
  const raw = rawBytesOf(doc, stream);
  if (raw === undefined) return undefined;
  // The size and the components come from the JPEG's own header: nothing is decoded until the pixels are read.
  // A JPEG whose own size differs from the dictionary's is drawn at the dictionary's size, resampled as pdf.js did (RGB,
  // grey and CMYK: measured byte for byte).
  const frame = jpegFrameOf(raw);
  if (frame === undefined || frame.components !== spaceComponents || !pictureSizeOk(frame.width, frame.height))
    return undefined;
  const ref = objectRefOf(declared);
  const alpha = maskStream !== undefined ? () => alphaOf(doc, maskStream, width, height) : undefined;
  // Decoded on first read, once (a JPEG the reader copies from its own bytes is never decoded). A decode that fails
  // gives no pixels, so the picture is counted as unreadable, not published wrong.
  let decoded: Uint8Array | undefined;
  return {
    ref,
    width,
    height,
    kind: maskStream !== undefined ? kinds.rgba : kinds.rgb,
    get data(): Uint8Array {
      decoded ??= pixelsOf(raw, { components: spaceComponents, decodes, width, height }, alpha);
      return decoded;
    },
    // 🔴 CE QUE CET OBJET PEUT RETENIR, et non ce qu'il retient à l'instant : ses octets comprimés PLUS les pixels
    // qu'un décodage matérialiserait. Un plafond se tient par EXCÈS, jamais par défaut.
    // Les deux bornes sont nécessaires, et chacune a été payée. Les PIXELS : le cache garde la fermeture pendant la
    // vie du DOCUMENT, pas de la page ; un chemin octet pour octet qui s'abstient plus tard (PDF chiffré, CMJN,
    // masque doux) lit `.data`, et les pixels mémoïsés resteraient facturés à un mégaoctet — soixante-quatre entrées
    // sous le plafond de 64 Mo auraient retenu 1,6 Go sur un exécuteur qui en a 512 (contre-revue du 03/11/2026).
    // Les octets COMPRIMÉS : pour un document chiffré ou un `/Filter [/FlateDecode /DCTDecode]`, `raw` est une COPIE
    // que l'ancien calcul par genre ne comptait pas du tout (revue sécurité du même jour).
    // ⚠️ BIAIS ÉCRIT : un JPEG republié octet pour octet, jamais décodé, est donc facturé bien plus qu'il ne retient,
    // et il occupe la place d'autres entrées. C'est le sens du plafond — une entrée qui PEUT tenir 26 Mo les paie.
    get heldBytes(): number {
      return raw.length + width * height * (maskStream !== undefined ? 4 : 3);
    },
  };
}

/** The pixels of a JPEG, as the accessor decides (CMYK through our conversion, RGB and grey through jpeg-js), with the
 *  alpha of its soft mask when it has one (RGBA). An empty array when the decode fails: the image reader then abstains. */
function pixelsOf(
  raw: Uint8Array,
  layout: { components: number; decodes: Decodes; width: number; height: number },
  alpha: (() => Uint8Array | undefined) | undefined,
): Uint8Array {
  const { components, decodes, width, height } = layout;
  const rgb =
    components === 4 ? cmykToRgb(raw, decodes, { width, height }) : withDecode(rgbOf(raw, { width, height }), decodes);
  if (rgb === undefined || rgb.width !== width || rgb.height !== height) return new Uint8Array(0);
  if (alpha === undefined) return rgb.data;
  const a = alpha();
  if (a === undefined) return new Uint8Array(0);
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    rgba[p * 4] = rgb.data[p * 3]!;
    rgba[p * 4 + 1] = rgb.data[p * 3 + 1]!;
    rgba[p * 4 + 2] = rgb.data[p * 3 + 2]!;
    rgba[p * 4 + 3] = a[p]!;
  }
  return rgba;
}
