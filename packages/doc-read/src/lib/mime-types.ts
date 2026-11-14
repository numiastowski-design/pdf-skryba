/** The MIME types the product names, spelled once, the one test of a Google-native file, and the ONE rule of which declared type
 *  crosses past a reader (`listedMimeType`: the picture types we name and the six original-file types, anything else neutral).
 *  A LEAF module: it imports nothing.
 *  NOT here: which types are accepted (`extractor/mime.ts`), image sniffing (the readers), nor the name an attachment takes
 *  (`core/attachment.ts`, which reads the two extension tables below).
 *  Called by: `extractor/mime.ts`, `adapters/forge-drive.ts`, `core/title.ts`; `listedMimeType` by `extractor/docx-reader/index.ts`,
 *  `extractor/xlsx.ts` and `adapters/forge-confluence-api.ts`; the two tables by `core/attachment.ts`. */

const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";
export const GOOGLE_DOC = "application/vnd.google-apps.document";
export const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
export const GOOGLE_SHORTCUT = "application/vnd.google-apps.shortcut";
export const GOOGLE_FOLDER = "application/vnd.google-apps.folder";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/** A Google-native file (Doc, Sheet, Slides, folder, shortcut…): it has no file extension. */
export const isGoogleNative = (mimeType: string): boolean => mimeType.startsWith(GOOGLE_APPS_PREFIX);

/** The extension each picture type is published under (`core/attachment.ts#attachmentFilename`): the keys are the picture types we NAME. */
export const EXT_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
};

/** The formats a file can be attached in, and the type each is declared with. */
export const SOURCE_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** The type a picture carries past the reader that found it, and into the
 *  upload's part header: a declared type crosses only when it is one of OURS
 *  (the keys of `EXT_BY_MIME` and the values of `SOURCE_TYPE_BY_EXTENSION`), byte for byte; anything else — a type we do not name,
 *  or one carrying CR LF to forge a header line — becomes the neutral
 *  `application/octet-stream`, the type of the `.bin` it is already named
 *  (review of 27/09/2026 night, finding 1). Same rule as upstream text: read
 *  to classify, never relayed. */
const OCTET_STREAM = "application/octet-stream";
export const listedMimeType = (declared: string | undefined): string =>
  declared !== undefined && (Object.hasOwn(EXT_BY_MIME, declared) || Object.values(SOURCE_TYPE_BY_EXTENSION).includes(declared)) ? declared : OCTET_STREAM;
