# pdf-skryba

Reads a PDF into a structured representation, and checks that no word was lost on the way.

The PDF reader of [Miksumia Publisher](https://miksumia.com), the Atlassian Marketplace
[app](https://marketplace.atlassian.com/apps/2647582831/miksumia-publisher-for-confluence) that turns
uploaded files into Confluence pages.

## Install

```sh
npm install pdf-skryba
```

ES modules only, for Node.js 24 or later; the types ship with the package. From CommonJS,
`require("pdf-skryba")` loads the same ES module on these Node.js versions.

## A complete example

```ts
// read.ts: node read.js report.pdf
import { readFileSync } from "node:fs";
import { extractPdf } from "pdf-skryba";
import type { ReaderError } from "pdf-skryba/light";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: node read.js <file.pdf>");

// A refusal is told by its name: that holds whichever entry, and whichever copy of the package, threw it.
const isRefusal = (error: unknown): error is ReaderError => error instanceof Error && error.name === "ReaderError";

// No AI reading here: with `ocr: false`, a page without a text layer is counted, never sent.
const vision = { analyzeDocument: () => Promise.reject(new Error("no AI reading configured")) };

try {
  const { doc, pageCount, notices } = await extractPdf(new Uint8Array(readFileSync(path)), vision, { ocr: false });
  console.log(`pages: ${pageCount}`);
  const [pages] = doc.blocks;
  if (pages?.kind === "tabs") console.log(`blocks on page 1: ${pages.tabs[0]?.blocks.length ?? 0}`);
  console.log(`notices: ${notices?.length ?? 0}`);
} catch (error) {
  if (!isRefusal(error)) throw error;
  console.error(`refused: ${error.code}`);
  process.exitCode = 1;
}
```

## Read a PDF

```js
import { readFileSync } from "node:fs";
import { extractPdf } from "pdf-skryba";

const bytes = new Uint8Array(readFileSync("report.pdf"));
const { doc, pageCount, notices } = await extractPdf(bytes, vision, { ocr: false });

pageCount;             // 12
doc.blocks[0].kind;    // "tabs" — one tab per page
doc.blocks[0].tabs[0]; // its blocks: headings, paragraphs, lists, tables, images
notices;               // every part it could not read, each with a named reason
```

## Scanned pages: the AI reading is yours

`vision` is a port you implement. It receives a small PDF holding the pages to read and returns one
result per page, in order. With `ocr: false` a page with no text layer is counted and never read; a
file that is a scan from end to end is refused (`SCANNED_PDF_NEEDS_AI_OCR`).

```js
const vision = {
  analyzeDocument: (slice, opts) => yourModel(slice, opts?.languages),
};

// Hand back the page pictures instead of refusing a full scan:
await extractPdf(bytes, vision, { ocr: false, scanAsImages: true });

// Or let the AI read every page, text layer included:
await extractPdf(bytes, vision, { readAll: true, languages: ["en", "fr"] });
```

## Your own ceilings

It withholds nothing by default: a ceiling shaped by where a document is going is yours to set. The
reader's own bounds (bytes, references, depth, glyphs) have values you can only lower.

```js
await extractPdf(bytes, vision, {
  limits: { pageLimit: 50, tableRows: 200, tableCols: 20 },
});
```

## Refusals carry a code

A refusal is an `Error` named `ReaderError`. Tell it by that name: it holds whichever entry, and
whichever copy of the package, threw the error. `pdf-skryba/light` exports the type.

```js
try {
  await extractPdf(bytes, vision, { ocr: false });
} catch (error) {
  if (error instanceof Error && error.name === "ReaderError") {
    error.code;       // "SCANNED_PDF_NEEDS_AI_OCR", "FILE_UNSAFE", "EXTRACT_FAILED"…
    error.pageCount;  // what it knew before refusing
  }
}
```

## Check what you published

`pdf-skryba/light` loads no reader. Hand it the text you published, block by block, and it tells you what
the page lost, invented, glued or split — in YOUR coordinates, never your markup.

```js
import { textConservation } from "pdf-skryba/light";

const { conservationSource } = await extractPdf(bytes, vision);
const verdict = textConservation(conservationSource.runs, { blocks: myPublishedTexts });

verdict.decision;      // "ok" | "lost" | "glued" | "abstain"
verdict.lostLetters;   // how many, and
verdict.lostPassages;  // where: each passage, with the page it came from
verdict.pages;         // the pages concerned
```

## Principles

- **One page, one tab.** Nothing of page 7 is attributed to page 6.
- **It abstains instead of inventing.** A glyph nothing identifies — `g03`, a composite font with no
  `/ToUnicode` — publishes nothing. Reading its number as a character puts stray letters into real sentences.
- **Silence is never an answer.** Every ceiling hit and every part it could not read comes back as a `notice`.
  Since 0.7.0 a `pdf-text-unread` notice names the pages published without their text, and those where a font
  could not be read (reason `font`): no stand-in table is tried, its words are missing and said so. Text a viewer
  would not show raises none.
- **Unreadable is not scanned.** Since 0.7.0 a page whose text could not be read never counts as a scan, and a
  file none of whose pages gave text is refused (`EXTRACT_FAILED`) instead of being published empty.
- **It can check itself.** Hand it the text you published, block by block (`pdf-skryba/light`, which loads no
  reader): it names what was lost, invented, glued or split, and returns repairs in YOUR coordinates.
- **Deterministic.** Same bytes, same document.
- **Every input is hostile.** Bytes, cross-references, reference hops, page-tree depth, operators, glyphs:
  each bound refuses with a named reason, never a guess.
- **It talks to nobody.** No network, no filesystem, no credentials — except the `vision` port, yours.

## Prior work

Side Liu, Jiangpeng Liu, Jinwen Xin, Guojun Peng and Jiang Ming, **"Beyond the Editing Canvas:
Evidence Divergence in OOXML-to-LLM Ingestion"**, arXiv:2608.25880 —
<https://arxiv.org/abs/2608.25880>. About the Office formats, not this one, and its lesson is why this
reader exists: the extraction path, not the model, decides what a language model sees.

## API

Four entries, two of them the minified twins of the others.

- `pdf-skryba` — the reader, `extractPdf`, called as `extractPdf(bytes, vision, options?)`; and
  `detectLanguage`; with the types of its options and results (`ExtractOptions`, `PdfDocumentFacts`…).
- `pdf-skryba/light` — loads no reader. The conservation check: `textConservation`, `lostWords`,
  `placeLostPassages`, `gluedWordEdits`, `cutParagraphEdits`, `noWorse`, `joinNoWorse`, `wordKeysOf`,
  `conservationKey`. Refusals and ceilings: `ReaderError`, `MAX_PAYLOAD_BYTES`. And the types of the
  representation (`IRDoc`, `IRBlock`, `TableData`…).
- `pdf-skryba/min` and `pdf-skryba/light/min` — the same code, minified.

## Publisher-only entries

The sub-paths under `pdf-skryba/first-party` exist for the publisher's own application. They are
**not a public API**: they may change or disappear in any version, and Semantic Versioning does not
cover them. The source is open, so nothing stops you from importing them; if you do, pin an exact
version.

## Versioning

The package follows [Semantic Versioning](https://semver.org): while it is `0.x`, a minor version
may break the published surface, and a patch never does. Each release is described in
`CHANGELOG.md`, shipped in the package.

## Contributing and security

See `CONTRIBUTING.md` and `SECURITY.md` in the
[repository](https://github.com/numiastowski-design/pdf-skryba). A contribution is received under
the MIT licence of the repository. Author: Miksumia.

## Licence

MIT (`LICENSE`), from version 0.9.0. Versions up to 0.8.0 stay under AGPL-3.0-or-later. The bundle
carries third-party material under its own notices (`THIRD-PARTY.md`). The test documents of the
repository are not under the MIT licence: each keeps its own, written in `fixtures/**/SOURCES.md`.

Named `skryba` until 0.6.2. Since 0.7.0 the code comes readable (`dist/index.js`), with the same code minified beside
it (`pdf-skryba/min`). This package ships a bundle and its source map. The Corresponding Source is published at
<https://github.com/numiastowski-design/pdf-skryba>, as one snapshot for each released version.
