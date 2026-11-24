/** Every ceiling of the PDF object reader: the lexer's (nesting, token, name, string), the cross-reference
 *  section's (chain, tail searched, entries, field width), the streams' (decoded bytes, object-stream members,
 *  containers cached), the document's (reference hops, page-tree depth, pages) and the content stream's
 *  (operands, operators).
 *  They exist so that hostile bytes cost a bounded, linear amount of work and a named refusal, never a stack
 *  overflow, a huge allocation or a walk that never ends. Starting value to calibrate: each is far above what
 *  real files carry and far below what an attack needs (names: ISO 32000-1 Annex C Table C.1 gives 127 bytes;
 *  the others are our own choice, and each says what population it was measured on, most of them none yet).
 *  NOT here: the values' meaning (each reader), the refusal type (`refusal.ts`), the register that names
 *  every one of them (in the application).
 *  Called by: `parse.ts`, `xref.ts`, `streams.ts`, `document.ts`, `content.ts`, and their tests.
 *
 *  🔴 WHICH ONES WERE SEEN BITING (repo rule: a guard that has not been seen biting is not a guard;
 *  survey of 31/10/2026, each checked by REMOVING the guard and watching the test fail):
 *  - SEEN BITING, ALL: the four of the lexer (A1), `MAX_XREF_SECTIONS`,
 *    `STARTXREF_SEARCH_BYTES`, `MAX_XREF_ENTRIES`, `MAX_XREF_FIELD_BYTES`, `MAX_TABLE_TOKEN_BYTES` (in
 *    `xref.ts`), `MAX_REF_HOPS`, `MAX_PAGE_TREE_DEPTH`, `MAX_CONTENT_OPERANDS`, `MAX_CONTENT_OPS`,
 *    `MAX_DECODED_STREAM_BYTES`, `MAX_OBJECT_STREAM_MEMBERS` and `MAX_OBJECT_STREAM_CACHE`. Two needed a
 *    special hook: the members ceiling is not seen in its refusal but in the fact that it refuses BEFORE
 *    decompressing (the test passes a decoder that fails if it is called), and the cache is a COST guard,
 *    so it is the eviction itself that is observed (`document.ts#remember`);
 *    and `MAX_PAGES`, whose "too expensive" trial I had written WITHOUT measuring it — the fault this POC paid
 *    three times in the day: measured, the 50 001-leaf file is 4 MB, is built in 20 ms and is
 *    refused in 169 ms (`tools/poc/cost-of-max-pages.ts` keeps the figure);
 *  - NO TEST CAN TELL IT APART, and this is written rather than disguised: `MIN_ENTRY_BYTES` alone (without it, the
 *    loop runs out of bytes and refuses the same way — it is a COST guard, not a verdict).
 *  THE BOUNDS BORN OF THE SECURITY REVIEWS OF 31/10/2026: `MAX_VALUE_NODES`, `MAX_FILTER_CHAIN`,
 *  `MAX_CONTENT_NODES`, `MAX_INLINE_IMAGE_ENTRIES` and, in `pdf-fonts/`, `MAX_CID_WIDTH_ENTRIES`,
 *  `MAX_TOUNICODE_PLACED` and `MAX_CMAP_TOKEN_BYTES` each have their test, seen biting the same way.
 *  `MAX_DOCUMENT_BYTES` has NONE, and this is written rather than disguised: making it really bite would take
 *  200 MB of real work in the suite. What IS tested of it is that every expense reaches it — the
 *  reference reading receives a budget that is injected into it, and two tests of `streams.test.ts` check
 *  that it charges it and that it refuses when it is exhausted.
 *  ⚠️ WHAT `MAX_DOCUMENT_BYTES` DOES NOT BOUND, and that must be known: it counts SOURCE bytes, not
 *  HEAP bytes. A dense array costs about 48 heap bytes per source byte, so this budget does not on its own
 *  prevent a large heap — it is `MAX_VALUE_NODES` (per value) and `MAX_CONTENT_NODES` (per content stream) that
 *  bound what is retained, and that is their reason for being.
 *  So: TWELVE bounds out of twelve seen biting, five of the six new ones too, and two that no test can
 *  tell apart at low cost (`MIN_ENTRY_BYTES`, `MAX_DOCUMENT_BYTES`), named. */

/** Levels of arrays and dictionaries one value may nest (the explicit stack of `parse.ts`, not the call stack). */
export const MAX_NESTING_DEPTH = 64;
/** Bytes of a number or bare-word token. */
export const MAX_TOKEN_BYTES = 64;
/** Bytes of a name once its `#xx` escapes are expanded. */
export const MAX_NAME_BYTES = 127;
/** Decoded bytes of a literal or hexadecimal string. */
export const MAX_STRING_BYTES = 1_048_576;

/** Sections of one `Prev` chain (ISO 32000-1 §7.5.6: one per incremental update, the newest first).
 *  Starting value to calibrate: no population measured yet. A file saved sixty-four times by a real editor is
 *  already extraordinary; a hostile file chains them to make us walk forever, and the visited-offset set
 *  already refuses a loop, so this only bounds a chain that never repeats an offset. */
export const MAX_XREF_SECTIONS = 64;

/** Bytes at the END of the file the last `startxref` is looked for in (§7.5.5 puts it there).
 *  Starting value to calibrate: pdf.js read the last 1 024 bytes; doubled here because a linearized file's
 *  tail also carries `/Prev`, `/ID` and sometimes a long `%%EOF` run. No corpus measured yet. */
export const STARTXREF_SEARCH_BYTES = 2_048;

/** Bytes one stream may decode to (`inflateSync`'s own ceiling, so a zlib bomb costs a refusal and not memory).
 *  Starting value to calibrate: the page layer already measured a single PDF page at 3,3 MB decompressed
 *  (STATUS, 03/10/2026) and the largest structure stream of the corpus is far below that; 64 MB is the package
 *  layer's own part ceiling, chosen so that the two readers refuse at the same scale. */
export const MAX_DECODED_STREAM_BYTES = 64_000_000;

/** Objects one object stream may hold (§7.5.7).
 *  Starting value to calibrate: no population measured yet. Real writers pack a few hundred objects per stream;
 *  this bounds the pair table a hostile `/N` can ask us to build before any member is read. */
export const MAX_OBJECT_STREAM_MEMBERS = 65_536;

/** Bytes one field of a cross-reference stream's `/W` may take (§7.5.8.2).
 *  Eight bytes already overflow what a byte offset can mean in a file we would accept; the conception of
 *  24/10/2026 fixed this ceiling. */
export const MAX_XREF_FIELD_BYTES = 8;

/** In-use entries one document's whole chain may place, all sections together.
 *  Starting value to calibrate: Annex C Table C.1 caps an object number at 8 388 607, which would be a 160 MB
 *  table on its own; this ceiling is eight times the largest table of our corpus measured so far (unmeasured:
 *  to fill in slice B) and bounds the memory a hostile `/Size` can ask for. */
export const MAX_XREF_ENTRIES = 1_048_576;

/** Hops of `N 0 R` → `M 0 R` one value may be followed through (`/Length`, `/SMask`, a colour space, an ICC
 *  profile). The conception of 24/10/2026 fixed eight; a real file needs one or two, and a hostile one chains them
 *  to make us walk. The set of objects being read refuses a cycle on its own. */
export const MAX_REF_HOPS = 8;

/** Levels of the page tree (§7.7.3.1). Starting value to calibrate: no population measured yet; a real writer
 *  balances the tree, so depth grows as the logarithm of the page count. */
export const MAX_PAGE_TREE_DEPTH = 64;

/** Pages one document may have. Starting value to calibrate: the largest of the corpus is 76 pages
 *  (`141-sand2022`, STATUS 31/10/2026); this is three orders of magnitude above it and bounds the walk. */
export const MAX_PAGES = 50_000;

/** Object streams kept decompressed at once. Starting value to calibrate. MEASURED 02/11/2026, a full `readPdfSource` of every document: 244
 *  corpus documents with object streams read 835 distinct containers in 851 reads (16 re-inflations in all, 4 at worst in one document), 36 fixture
 *  documents 177 containers in 180 reads (3 re-inflations): the first reads of a real document come in container order, so a FIFO of 8 re-inflates
 *  almost nothing. A document whose objects are spread over hundreds of containers must not keep them all in memory. */
export const MAX_OBJECT_STREAM_CACHE = 8;

/** Operands one operator of a content stream may be given (§7.8.2). pdf.js stopped at 33; 64 is twice the largest
 *  any operator of the clause takes (`d0`, `sh`, `TJ` take one array), so nothing real is near it. */
export const MAX_CONTENT_OPERANDS = 64;

/** Nodes (operators AND operands) that a content stream may make us RETAIN.
 *  🔴 `high` review of 31/10/2026: the operators ceiling did not bound memory. Three million
 *  operators carrying up to 64 operands each make 192 million retained values; and a stream of
 *  42 MB of `1 1 1 1 1 1 cm ` — a zlib bomb of about 40 KB — passed under both existing ceilings while
 *  retaining about 700 MB.
 *  🔴 TWO MILLION AND NOT FOUR (security review of 31/10/2026, third pass): the reasoning "~48 bytes
 *  per node, so four million bound the heap at ~190 MB" does NOT hold for an operator. A bare operator
 *  retains three things — the `ContentOp` object, its operands array, and its string taken from the stream — that is
 *  of the order of 110 bytes, not 48. At the old figure, a stream of repeated `w ` (a zlib bomb of ten or so
 *  kilobytes) retained ~340 MB on a runtime that has 512. Two million bound the retained heap at ~160 MB
 *  in the worst mix of operators and operands, and the densest page of the corpus needs less than
 *  fifty thousand (6 907 operators, measured on 03/10/2026). */
export const MAX_CONTENT_NODES = 2_000_000;

/** Operators one content stream may hold.
 *  🔴 ARBITRARY THRESHOLD, settled on 31/10/2026: a "clear refusal" rather than a memory risk. It
 *  was three million, which allowed ~340 MB of retained heap (see `MAX_CONTENT_NODES`). One million is
 *  one hundred and forty-five times the densest page we have measured (6 907 operators, 03/10/2026), so no
 *  known real document is refused by this decrease; the accepted price is that a page carrying more than one
 *  million drawing operators is refused instead of being attempted.
 *  `PDF_MAX_OPS_PER_PAGE` (`extractor/pdf-source.ts`) is DELIBERATELY the same number, so that the two
 *  readers refuse the same page; the two go down together or not at all. */
export const MAX_CONTENT_OPS = 1_000_000;

/** Form XObject expansions ONE PAGE may make, counted across every reader that unrolls them (`pdf-ops-ours.ts`,
 *  `pdf-glyph-source.ts`, `pdf-font-bridge.ts`).
 *  🔴 WHY (security review of 02/11/2026): the depth was capped at 8 but the number of calls was not, so a form that
 *  calls the next one a hundred times is 10^16 expansions at depth 8 from a few hundred bytes, each one re-reading a stream
 *  the document budget charges a handful of bytes for. Starting value to calibrate, two populations measured on
 *  02/11/2026: the 342 pages of `fixtures/pdf` make at most 16 expansions (a Canva booklet), the 55 pages of the corpus's
 *  `pdf` folder at most 12; the ceiling is about six hundred times the first. Accepted price: a page that draws more
 *  than ten thousand forms is refused (`forms-too-many`) instead of attempted. */
export const MAX_FORM_CALLS_PER_PAGE = 10_000;

/** Entries an inline image dictionary may carry (§8.9.7, Table 93 names twelve).
 *  🔴 WHY (security review of 31/10/2026): a whole `BI` cost ONE node, so its dictionary
 *  was bounded by nothing. A stream of 64 MB of `BI /Aaaaaa 0 /Aaaaab 0 … ID x EI` — ten bytes and a
 *  new key per entry — retained of the order of six million Map entries, close to a gigabyte, while
 *  the node counter read 1. The dictionary's nodes are now counted TOO, and this ceiling
 *  bounds the number of keys: sixty-four is five times the table of the clause. */
export const MAX_INLINE_IMAGE_ENTRIES = 64;

/** Filters a stream may chain (§7.4). Two suffice for any honest file (`[/ASCII85Decode
 *  /FlateDecode]`); beyond eight, it is an input trying to make the reader work — a `/Filter`
 *  of a hundred thousand names fits in half a megabyte (security review of 31/10/2026). */
export const MAX_FILTER_CHAIN = 8;

/** Nodes (numbers, names, strings, array elements, dictionary entries) that ONE value may carry.
 *  🔴 WHY (security review of 31/10/2026): only the DEPTH was bounded, never the NUMBER. An object
 *  containing `[1 1 1 …]` costs about 48 heap bytes per number, so 20 MB of file made 480 MB — and
 *  through an object stream, 64 KB compressed made as much. One million nodes lets the largest real
 *  arrays through (a CID font `/W`, a `/Differences`) and caps the heap at a few tens of megabytes.
 *  Starting value to calibrate: the largest object of the corpus has not been measured. */
export const MAX_VALUE_NODES = 1_000_000;

/** Bytes that ONE document may have parsed and decompressed in all — the sum of the objects read and of the streams
 *  decoded, the same stream counted at each read.
 *  🔴 WHY (security review of 31/10/2026): every ceiling was LOCAL. An object stream may name the same
 *  member thousands of times, and each number is parsed then kept apart, so the work was worth
 *  members × member size (50 000 × 100 KB = 5 GB) without the 65 536 members ceiling seeing it; and a
 *  chain of 64 reference sections could decompress 64 MB each. This budget is the only one that is CUMULATIVE,
 *  and it is what bounds the whole document.
 *  ⚠️ THAT LAST SENTENCE WAS FALSE UNTIL THE EVENING OF 31/10/2026, and it is the security review that said so: the
 *  chain of reference sections WAS NOT counted. `readXref` ran BEFORE this budget existed, and
 *  `xref.ts` called `decodeStream` directly; with `/W [1 1 1] /Index [0 1]`, the post-decompression
 *  check passes whatever the size, so each of the 64 sections could inflate 64 MB — about
 *  4 GB without a byte being counted, from a 4 MB file. Fixed at the source: the budget is created before
 *  the reading of the references and is PASSED to it (`xref.ts#SpendBytes`), and the `streamBytes` shortcut for a
 *  `/Type /XRef` stream — a type that the FILE chooses, on any stream — pays too.
 *  Starting value to calibrate: four times the largest file the app accepts (50 MB, `MAX_PAYLOAD_BYTES`),
 *  which lets through a PDF whose whole content is compressed to a quarter. */
export const MAX_DOCUMENT_BYTES = 200_000_000;

/** What a retained node costs in heap, in bytes — the order of magnitude of a `PdfValue` and of its array
 *  slot. It is used to count nodes WITHIN the document budget, which is in bytes: without it, two bytes of
 *  source could retain one node, and 200 MB of budget allowed a hundred million nodes, that is
 *  gigabytes. ARBITRARY value: not measured here.
 *  ⚠️ WHAT IT DOES NOT COVER, and that must be known (security review of 31/10/2026): a content stream
 *  OPERATOR is not a 48-byte node. It retains three things — the `ContentOp` object, its operands array
 *  and its string taken from the stream — that is of the order of 110 bytes. The node counter bills it only one, so
 *  it is `MAX_CONTENT_OPS` that bounds that expense, and that is why the two ceilings were lowered
 *  together. A single figure for the two families of nodes would be false for one of them. */
export const HEAP_PER_NODE = 48;

/** What a content stream OPERATOR retains once tokenized: the `ContentOp`, its operands array and its string, of the order of 110 bytes (security review of
 *  31/10/2026, see above: not a 48-byte node). ARBITRARY start value, not measured here; the cache of tokenized forms prices an operator with it. */
export const HEAP_PER_OPERATOR = 110;
