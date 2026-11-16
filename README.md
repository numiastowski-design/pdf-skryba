# skryba

Reads a PDF into a structured representation, and checks that no word was lost on the way.

The PDF reader of [Miksumia Publisher](https://miksumia.com), the Atlassian Marketplace
[app](https://marketplace.atlassian.com/apps/2647582831/miksumia-publisher-for-confluence) that turns
uploaded files into Confluence pages.

Published on npm as [`skryba`](https://www.npmjs.com/package/skryba): `npm i skryba`.

## Read a PDF

```js
import { readFileSync } from "node:fs";
import { extractPdf } from "skryba";

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

```js
import { ReaderError } from "skryba/light";

try {
  await extractPdf(bytes, vision, { ocr: false });
} catch (error) {
  if (error instanceof ReaderError) {
    error.code;       // "SCANNED_PDF_NEEDS_AI_OCR", "FILE_UNSAFE", "EXTRACT_FAILED"…
    error.pageCount;  // what it knew before refusing
  }
}
```

## Check what you published

`skryba/light` loads no reader. Hand it the text you published, block by block, and it tells you what
the page lost, invented, glued or split — in YOUR coordinates, never your markup.

```js
import { textConservation } from "skryba/light";

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
- **It can check itself.** Hand it the text you published, block by block (`skryba/light`, which loads no
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

## Licence

AGPL-3.0-or-later: run a modified version as a network service and its source must be available to its
users. This repository is that source — a snapshot of the packages the npm bundle is built from, taken
from the development monorepo at version 0.6.2 (16 November 2026). The entry points are
`packages/doc-read/src/lib/pdf.ts` and `packages/doc-read/src/lib/pdf-light.ts`; the npm package ships
the bundle built from them. Questions: <contact@miksumia.com>.
