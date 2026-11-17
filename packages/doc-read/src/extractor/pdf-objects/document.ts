/** The document the object reader gives: every object reachable through the cross-reference section (compressed
 *  and encrypted ones included), and the page tree (ISO 32000-1:2008 §7.3.10 indirect objects, §7.5.7 object
 *  streams, §7.6 encryption, §7.7.2 catalog, §7.7.3 page tree and the inheritable attributes of Table 29).
 *  Decides: that the object FOUND at an offset must carry the NUMBER the table promised — this is how a stale
 *  table shows itself (`xref-stale`), and the one check neither pdf-lib nor a byte scan makes; how far a chain of
 *  references may be followed; that an object is read once and kept; which node of the page tree is a leaf (its
 *  `/Type`, or the absence of `/Kids` when the file does not say); what a page MEASURES — the CropBox clipped to
 *  the MediaBox, corners normalised, which is what pdf.js's `page.view` gave (history: the two readings were compared before its removal); and that
 *  a document we cannot decrypt is REFUSED rather than half-read.
 *  TWO DELIBERATE DIVERGENCES FROM pdf.js (removed from the product; history), both written in `docs/POC-SANS-PDFJS.md`: a page with no MediaBox is
 *  REFUSED here (`page-box`) where pdf.js invented US Letter; a `/Rotate` that is not a quarter turn reads as 0,
 *  which is what pdf.js did, so that one was deliberate agreement.
 *  NOT here: the cross-reference section itself (`xref.ts`), decoding (`streams.ts`), the lexer (`parse.ts`), the
 *  standard security handler (`extractor/pdf-decrypt.ts`), content streams and fonts.
 *  Called by: the POC's tools (`tools/poc/`), and `document.test.ts`. */

import { standardOutcome, type StandardSecurity } from "../pdf-decrypt";
import {
  HEAP_PER_NODE,
  MAX_DOCUMENT_BYTES,
  MAX_OBJECT_STREAM_CACHE,
  MAX_PAGE_TREE_DEPTH,
  MAX_PAGES,
  MAX_REF_HOPS,
} from "./bounds";
import type { PdfDict, PdfRef, PdfStream, PdfValue } from "./objects";
import { parseIndirectObject } from "./parse";
import { PdfObjectsRefusal } from "./refusal";
import {
  decodeStream,
  decodeToImageFilter,
  IMAGE_FILTERS,
  readObjectStream,
  type ObjectStreamMembers,
} from "./streams";
import { readXref, type Xref } from "./xref";

/** One page of the tree, with what it inherited already applied. */
export interface PdfPageEntry {
  readonly ref: PdfRef;
  readonly dict: PdfDict;
  /** As pdf.js's `page.view` was: `[x0, y0, x1, y1]`, the CropBox clipped to the MediaBox, corners normalised. */
  readonly view: readonly [number, number, number, number];
  /** A quarter turn in [0, 360); 0 when the file's value is not a multiple of 90 (pdf.js did the same). */
  readonly rotate: number;
  readonly resources: PdfDict | undefined;
}

export interface PdfObjectsDocument {
  /** The merged trailer of the chain (§7.5.6). */
  trailer(): PdfDict;
  /** Follows references until a direct value; a direct value is returned as it is. */
  resolve(value: PdfValue | undefined): PdfValue | undefined;
  /** The dictionary of a dictionary or of a stream, references followed; `undefined` for anything else. */
  dictOf(value: PdfValue | undefined): PdfDict | undefined;
  /** The decoded bytes of a stream, decrypted first when the document is encrypted (`streams.ts`). */
  streamBytes(stream: PdfStream): Uint8Array;
  /** The stream's bytes as the file holds them, decrypted when the document is encrypted, and NOT decoded: for a stream
   *  whose filter is an image format we decode ourselves (a JPEG, a CCITT picture). Refused when encrypted and its
   *  holder is unknown. */
  rawStreamBytes(stream: PdfStream): Uint8Array;
  /** A PICTURE's bytes, decrypted, with the NON-image filters of its chain undone, and the image filter left for the
   *  image decoders (`undefined` when there is none). The reading an image decoder wants when `/Filter` is a CHAIN,
   *  such as a JPEG compressed again with Flate (`streams.ts#decodeToImageFilter`). */
  imageStreamOf(stream: PdfStream): { readonly imageFilter: string | undefined; readonly data: Uint8Array };
  /** The pages, in the order the tree gives them. */
  pages(): readonly PdfPageEntry[];
}

/** What the page-tree walk needs of the document: nothing but two lookups. */
interface Lookups {
  resolve(value: PdfValue | undefined): PdfValue | undefined;
  dictOf(value: PdfValue | undefined): PdfDict | undefined;
}

type Box = readonly [number, number, number, number];

/** §7.9.5: a rectangle is a pair of OPPOSITE corners, in either order. */
const normalizeBox = ([a, b, c, d]: Box): Box => [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];

/** The overlap of two normalised boxes, or `undefined` when they do not overlap (pdf.js's `Util.intersect`). */
function intersect(one: Box, other: Box): Box | undefined {
  const x0 = Math.max(one[0], other[0]);
  const y0 = Math.max(one[1], other[1]);
  const x1 = Math.min(one[2], other[2]);
  const y1 = Math.min(one[3], other[3]);
  return x0 < x1 && y0 < y1 ? [x0, y0, x1, y1] : undefined;
}

/** A box of four numbers, references followed; `undefined` when the entry is absent or is not one. */
function boxOf(at: Lookups, dict: PdfDict, key: string): Box | undefined {
  const array = at.resolve(dict.get(key));
  if (array?.kind !== "array" || array.items.length !== 4) return undefined;
  const numbers = array.items.map((item) => {
    const value = at.resolve(item);
    return value?.kind === "number" && Number.isFinite(value.value) ? value.value : undefined;
  });
  if (numbers.some((value) => value === undefined)) return undefined;
  return normalizeBox(numbers as unknown as Box);
}

/** The inheritable attributes of Table 29, as the walk carries them down the tree. */
interface Inherited {
  readonly resources: PdfDict | undefined;
  readonly mediaBox: Box | undefined;
  readonly cropBox: Box | undefined;
  readonly rotate: number;
}

const EMPTY_INHERITED: Inherited = { resources: undefined, mediaBox: undefined, cropBox: undefined, rotate: 0 };

function inheritedOf(at: Lookups, dict: PdfDict, parent: Inherited): Inherited {
  const rotate = at.resolve(dict.get("Rotate"));
  return {
    resources: at.dictOf(dict.get("Resources")) ?? parent.resources,
    mediaBox: boxOf(at, dict, "MediaBox") ?? parent.mediaBox,
    cropBox: boxOf(at, dict, "CropBox") ?? parent.cropBox,
    rotate: rotate?.kind === "number" ? rotate.value : parent.rotate,
  };
}

/** The rule pdf.js applied (`Page.get rotate`): a value that is not a multiple of 90 reads as 0. */
function quarterTurn(rotate: number): number {
  if (!Number.isInteger(rotate) || rotate % 90 !== 0) return 0;
  return ((rotate % 360) + 360) % 360;
}

function pageOf(ref: PdfRef, dict: PdfDict, inherited: Inherited): PdfPageEntry {
  const { mediaBox, cropBox } = inherited;
  // pdf.js invented US Letter here; we abstain. A page whose size nothing declares cannot be laid out.
  if (mediaBox === undefined) throw new PdfObjectsRefusal("page-box", ref.num);
  const view = cropBox === undefined ? mediaBox : (intersect(cropBox, mediaBox) ?? mediaBox);
  return { ref, dict, view, rotate: quarterTurn(inherited.rotate), resources: inherited.resources };
}

interface Node {
  readonly ref: PdfRef;
  readonly dict: PdfDict;
  readonly inherited: Inherited;
  readonly depth: number;
}

/** The kids of one intermediate node, pushed so that the stack hands them back in the file's order (§7.7.3.2).
 *  🔴 THE PAGES CEILING IS CHECKED HERE, when pushing (security review of 31/10/2026): it was only checked at the
 *  POPPED LEAF, so a flat `/Kids` of 900 000 references — a few megabytes with an object stream —
 *  made every child be resolved, parsed and pushed BEFORE any refusal, close to a gigabyte for a
 *  document of which the product accepts only fifteen pages anyway. */
function pushKids(at: Lookups, node: Node, kids: readonly PdfValue[], stack: Node[], found: number): void {
  if (node.depth >= MAX_PAGE_TREE_DEPTH) throw new PdfObjectsRefusal("page-tree", node.ref.num);
  if (found + stack.length + kids.length > MAX_PAGES) throw new PdfObjectsRefusal("page-tree", node.ref.num);
  for (let i = kids.length - 1; i >= 0; i -= 1) {
    const ref = kids[i];
    if (ref?.kind !== "ref") throw new PdfObjectsRefusal("page-tree", node.ref.num);
    const dict = at.dictOf(ref);
    if (dict === undefined) throw new PdfObjectsRefusal("page-tree", ref.num);
    stack.push({ ref, dict, inherited: inheritedOf(at, dict, node.inherited), depth: node.depth + 1 });
  }
}

/** §7.7.3: the leaves of the page tree, in order. An explicit stack, so depth is a counter checked before each
 *  descent and never the call stack; a node seen twice is a loop and refuses the document. */
function walkPageTree(at: Lookups, trailer: PdfDict): readonly PdfPageEntry[] {
  const catalog = at.dictOf(trailer.get("Root"));
  const treeRef = catalog?.get("Pages");
  const tree = at.dictOf(treeRef);
  if (tree === undefined || treeRef?.kind !== "ref") throw new PdfObjectsRefusal("page-tree");

  const found: PdfPageEntry[] = [];
  const visited = new Set<number>();
  const stack: Node[] = [{ ref: treeRef, dict: tree, inherited: inheritedOf(at, tree, EMPTY_INHERITED), depth: 0 }];

  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (visited.has(node.ref.num)) throw new PdfObjectsRefusal("page-tree", node.ref.num);
    visited.add(node.ref.num);

    const type = at.resolve(node.dict.get("Type"));
    const kids = at.resolve(node.dict.get("Kids"));
    const isLeaf = type?.kind === "name" ? type.value === "Page" : kids?.kind !== "array";
    if (isLeaf) {
      if (found.length >= MAX_PAGES) throw new PdfObjectsRefusal("page-tree");
      found.push(pageOf(node.ref, node.dict, node.inherited));
      continue;
    }
    if (kids?.kind !== "array") throw new PdfObjectsRefusal("page-tree", node.ref.num);
    pushKids(at, node, kids.items, stack, found.length);
  }
  return found;
}

/** §7.6: what the trailer says about encryption, as the plain data `pdf-decrypt.ts` takes — no pdf-lib, no
 *  pdf.js, which is the narrow interface the conception of 24/10/2026 asked for and which already existed.
 *  `undefined` when the document is in the clear. */
function securityOf(at: Lookups, trailer: PdfDict): StandardSecurity | undefined {
  const encrypt = at.dictOf(trailer.get("Encrypt"));
  if (encrypt === undefined) return undefined;
  const filter = at.resolve(encrypt.get("Filter"));
  // Only the standard handler is read here; anything else is refused rather than half-read.
  if (filter?.kind !== "name" || filter.value !== "Standard") throw new PdfObjectsRefusal("encrypted");

  const integer = (key: string, fallback: number): number => {
    const value = at.resolve(encrypt.get(key));
    return value?.kind === "number" ? value.value : fallback;
  };
  const stringOf = (key: string): Uint8Array => {
    const value = at.resolve(encrypt.get(key));
    return value?.kind === "string" ? value.bytes : new Uint8Array(0);
  };
  const metadata = at.resolve(encrypt.get("EncryptMetadata"));
  const id = at.resolve(trailer.get("ID"));
  const idFirst = id?.kind === "array" ? at.resolve(id.items[0]) : undefined;

  return {
    v: integer("V", 0),
    r: integer("R", 0),
    lengthBits: integer("Length", 40),
    o: stringOf("O"),
    u: stringOf("U"),
    p: integer("P", 0),
    idFirst: idFirst?.kind === "string" ? idFirst.bytes : new Uint8Array(0),
    encryptMetadata: metadata?.kind === "bool" ? metadata.value : true,
  };
}

interface Decryptor {
  decryptStream(num: number, gen: number, data: Uint8Array): Uint8Array;
}

/** One stream's bytes: decrypted first when the document is encrypted (§7.6.2 decrypts with the number AND the
 *  generation of the object that HOLDS the stream), then unfiltered — §7.6.1 applies encryption after the
 *  filters, so it is undone before them, on a buffer that now starts at 0. */
function decodedStream(
  bytes: Uint8Array,
  stream: PdfStream,
  owner: PdfRef | undefined,
  decryptor: Decryptor | undefined,
): Uint8Array {
  if (decryptor === undefined) return decodeStream(bytes, stream);
  // An encrypted stream whose holder we do not know cannot be decrypted, and its raw bytes are not its bytes:
  // a refusal, never plausible-looking wrong data (review of 31/10/2026).
  if (owner === undefined) throw new PdfObjectsRefusal("encrypted");
  const raw = decryptor.decryptStream(owner.num, owner.gen, bytes.subarray(stream.start, stream.start + stream.length));
  return decodeStream(raw, { ...stream, start: 0, length: raw.length });
}

/** §7.6.2: in an encrypted document the STRINGS are encrypted too, with the same object key as its streams —
 *  so a string read without this is ciphertext handed over as if it were text. Rebuilt rather than mutated, and
 *  the recursion is bounded by the parser's own nesting ceiling (`MAX_NESTING_DEPTH`, 64), which the value has
 *  already passed to exist at all.
 *  NOT applied to an object that lives in an object STREAM (§7.5.7: the container was decrypted as a whole, its
 *  members never again), nor to the `/Encrypt` dictionary itself (§7.6.1: `/O` and `/U` are in the clear). */
function withDecryptedStrings(value: PdfValue, num: number, gen: number, decryptor: Decryptor): PdfValue {
  if (value.kind === "string") return { kind: "string", bytes: decryptor.decryptStream(num, gen, value.bytes) };
  if (value.kind === "array") {
    return { kind: "array", items: value.items.map((item) => withDecryptedStrings(item, num, gen, decryptor)) };
  }
  if (value.kind === "dict" || value.kind === "stream") {
    const entries = new Map<string, PdfValue>();
    for (const [key, entry] of value.kind === "dict" ? value.entries : value.dict) {
      entries.set(key, withDecryptedStrings(entry, num, gen, decryptor));
    }
    return value.kind === "dict" ? { kind: "dict", entries } : { ...value, dict: entries };
  }
  return value;
}

/** A value kept in a cache that holds at most `max` of them, the oldest leaving first. Exported for its test:
 *  `MAX_OBJECT_STREAM_CACHE` is a COST ceiling, so nothing it does changes a verdict, and the only way to see it
 *  bite is to watch the eviction itself (31/10/2026). */
export function remember<K, V>(cache: Map<K, V>, key: K, value: V, max: number): V {
  if (cache.size >= max) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
  return value;
}

/** The decryptor read ONCE, its refusal KEPT: without keeping it, the second call would find no decryptor, take
 *  the clear-document path and decode ciphertext as if it were plain — plausible-looking wrong bytes, the one
 *  thing this module promises never to produce (third review of 31/10/2026). */
function decryptionMemo(at: Lookups, trailer: PdfDict): () => Decryptor | undefined {
  let read = false;
  let decryptor: Decryptor | undefined;
  let refusal: unknown;
  return () => {
    if (!read) {
      read = true;
      try {
        decryptor = decryptorOf(at, trailer);
      } catch (error) {
        refusal = error;
      }
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the refusal caught on the first call, thrown again as caught (`allowRethrowing` covers only a throw inside the catch).
    if (refusal !== undefined) throw refusal;
    return decryptor;
  };
}

/** The decryptor of an encrypted document. A real password, or an algorithm `pdf-decrypt.ts` does not implement
 *  (AES), is a REFUSAL: we never half-read a document. */
function decryptorOf(at: Lookups, trailer: PdfDict): Decryptor | undefined {
  const security = securityOf(at, trailer);
  if (security === undefined) return undefined;
  const outcome = standardOutcome(security);
  if (outcome.kind !== "decryptor") throw new PdfObjectsRefusal("encrypted");
  return outcome.decryptor;
}

/** The three ways to read a stream's bytes: decoded (`streamBytes`), decrypted only (`rawStreamBytes`), and a
 *  picture's (`imageStreamOf`: decrypted, its non-image filters undone, the image filter named). All three are
 *  paid for out of the document's one budget (`spend`). */
function streamReadersOf(
  bytes: Uint8Array,
  spend: (count: number) => void,
  owners: ReadonlyMap<number, PdfRef>,
  decryptor: () => Decryptor | undefined,
): {
  // Function properties, not methods: the caller destructures them, and none reads `this`.
  streamBytes: (stream: PdfStream) => Uint8Array;
  rawStreamBytes: (stream: PdfStream) => Uint8Array;
  imageStreamOf: (stream: PdfStream) => { readonly imageFilter: string | undefined; readonly data: Uint8Array };
} {
  function streamBytes(stream: PdfStream): Uint8Array {
    const type = stream.dict.get("Type");
    // §7.5.8.2 and §7.6.1: a cross-reference stream is never encrypted — which is lucky, since it has to be read
    // to find the `/Encrypt` dictionary in the first place.
    // 🔴 BUT IT IS PAID FOR LIKE THE OTHERS (security review of 31/10/2026): this shortcut also gave control back
    // without counting anything, and the `/Type` is chosen by the FILE, on any stream. A `/Contents` that
    // names ten times a stream marked `/Type /XRef` carrying a 64 MB bomb thus made 640 MB be decompressed
    // with zero bytes on the budget. Decryption is what is skipped here, never the expense.
    if (type?.kind === "name" && type.value === "XRef") {
      const raw = decodeStream(bytes, stream);
      spend(raw.length);
      return raw;
    }
    const decoded = decodedStream(bytes, stream, owners.get(stream.start), decryptor());
    spend(decoded.length);
    return decoded;
  }

  /** The raw bytes of a stream: decrypted with its holder's key when the document is encrypted, never decoded. */
  function rawStreamBytes(stream: PdfStream): Uint8Array {
    const span = bytes.subarray(stream.start, stream.start + stream.length);
    const dec = decryptor();
    if (dec === undefined) {
      spend(span.length);
      return span;
    }
    const owner = owners.get(stream.start);
    if (owner === undefined) throw new PdfObjectsRefusal("encrypted");
    const raw = dec.decryptStream(owner.num, owner.gen, span);
    spend(raw.length);
    return raw;
  }

  /** A picture's bytes: decrypted like `rawStreamBytes`, then the NON-image filters of the chain undone. What the
   *  undoing produces is paid for too — inflating a Flate-wrapped JPEG costs as much as inflating anything else. */
  function imageStreamOf(stream: PdfStream): { readonly imageFilter: string | undefined; readonly data: Uint8Array } {
    const raw = rawStreamBytes(stream);
    const picture = decodeToImageFilter(raw, stream.dict);
    if (picture.data !== raw) spend(picture.data.length);
    return picture;
  }

  return { streamBytes, rawStreamBytes, imageStreamOf };
}

/** A fresh cumulative budget: each call adds to what was spent, and past `MAX_DOCUMENT_BYTES` it refuses. */
function documentBudget(): (count: number) => void {
  let spent = 0;
  return (count) => {
    spent += count;
    if (spent > MAX_DOCUMENT_BYTES) throw new PdfObjectsRefusal("document-too-large");
  };
}

/** A value with its references followed through `objectOf`, at most `MAX_REF_HOPS` of them. */
function followRefs(
  value: PdfValue | undefined,
  objectOf: (num: number) => PdfValue | undefined,
): PdfValue | undefined {
  let current = value;
  let hops = 0;
  while (current?.kind === "ref") {
    hops += 1;
    if (hops > MAX_REF_HOPS) throw new PdfObjectsRefusal("ref-hops", current.num);
    current = objectOf(current.num);
  }
  return current;
}

export function openPdfObjects(bytes: Uint8Array): PdfObjectsDocument {
  /** 🔴 THE ONLY CUMULATIVE BUDGET of the reader (security review of 31/10/2026): all the other ceilings are LOCAL,
   *  so a document could cross them a great number of times — the same member of an object stream parsed
   *  thousands of times, or sixty-four reference sections decompressing 64 MB each. Here we count
   *  the bytes parsed and decompressed, the same stream counted at each read.
   *  🔴 IT IS CREATED BEFORE `readXref`, AND PASSED INTO IT (same review, third pass): reading the references
   *  decompresses, it ran before this budget existed, and it is precisely the expense that its own
   *  header claimed to bound. Declared here, it covers the document from the first byte to the last. */
  const spend = documentBudget();
  const xref: Xref = readXref(bytes, spend);
  const objects = new Map<number, PdfValue | undefined>();
  const containers = new Map<number, ObjectStreamMembers>();
  /** Objects whose reading is under way, so a `/Length` that points back at one is refused, never followed. */
  const reading = new Set<number>();
  /** Which object a stream came from, by the offset of its first data byte: §7.6.2 decrypts a stream with the
   *  number AND generation of the object that holds it, and a `PdfStream` does not carry them. */
  const owners = new Map<number, PdfRef>();

  function resolve(value: PdfValue | undefined): PdfValue | undefined {
    return followRefs(value, objectOf);
  }

  function dictOf(value: PdfValue | undefined): PdfDict | undefined {
    const resolved = resolve(value);
    if (resolved?.kind === "dict") return resolved.entries;
    return resolved?.kind === "stream" ? resolved.dict : undefined;
  }

  const lookups: Lookups = { resolve, dictOf };
  const decryptor = decryptionMemo(lookups, xref.trailer);
  /** The object that HOLDS the `/Encrypt` dictionary, whose own strings are never encrypted (§7.6.1). */
  const encryptRef = xref.trailer.get("Encrypt");
  const encryptNum = encryptRef?.kind === "ref" ? encryptRef.num : undefined;
  const { streamBytes, rawStreamBytes, imageStreamOf } = streamReadersOf(bytes, spend, owners, decryptor);

  /** §7.3.8.2: the integer a `/Length` reference names, or `undefined` when it cannot be had. */
  function lengthOf(ref: PdfRef): number | undefined {
    const value = objectOf(ref.num);
    return value?.kind === "number" && Number.isInteger(value.value) && value.value >= 0 ? value.value : undefined;
  }

  /** The members of an object stream, read once per container, in a small bounded cache. */
  function membersOf(num: number): ObjectStreamMembers {
    const known = containers.get(num);
    if (known !== undefined) return known;
    const container = objectOf(num);
    if (container?.kind !== "stream") throw new PdfObjectsRefusal("object-stream", num);
    const type: PdfValue | undefined = container.dict.get("Type");
    if (type?.kind !== "name" || type.value !== "ObjStm") throw new PdfObjectsRefusal("object-stream", num);
    const members = readObjectStream(bytes, container, (_, stream) => streamBytes(stream));
    return remember(containers, num, members, MAX_OBJECT_STREAM_CACHE);
  }

  function objectAtOffset(num: number, offset: number, gen: number): PdfValue {
    if (offset >= bytes.length) throw new PdfObjectsRefusal("xref-stale", num);
    const parsed = parseIndirectObject(bytes, offset, lengthOf);
    // The bytes read AND the nodes retained: a node costs about 48 heap bytes, and it is what weighs
    // (`medium` review of 31/10/2026 — two source bytes can retain one node).
    spend(parsed.end - offset + parsed.nodes * HEAP_PER_NODE);
    // THE CHECK that no byte scan makes: the table promised object `num`, GENERATION included — §7.3.10 makes
    // the generation half of an object's identity, and an incremental update that bumps it while the old object
    // still sits at the offset is exactly how a table goes stale (review of 31/10/2026).
    if (parsed.num !== num || parsed.gen !== gen) throw new PdfObjectsRefusal("xref-stale", num);
    if (parsed.value.kind === "stream")
      owners.set(parsed.value.start, { kind: "ref", num: parsed.num, gen: parsed.gen });
    // The `/Encrypt` dictionary is read to BUILD the decryptor, and its own strings are in the clear.
    if (num === encryptNum) return parsed.value;
    const decrypt = decryptor();
    return decrypt === undefined ? parsed.value : withDecryptedStrings(parsed.value, parsed.num, parsed.gen, decrypt);
  }

  function objectInContainer(num: number, container: number): PdfValue {
    const members = membersOf(container);
    // 🔴 READING A MEMBER IS WORK, and it must be counted (`high` review of 31/10/2026): an object stream may
    // name the SAME member thousands of times, each number is parsed then kept apart, and nothing
    // counted it — two thousand pairs pointing at a one-megabyte dictionary fit in twenty kilobytes and
    // made two gigabytes be parsed.
    spend(members.extentOf(num));
    const member = members.valueOf(num);
    // The table said this container holds the object and it does not: the table is stale.
    if (member === undefined) throw new PdfObjectsRefusal("xref-stale", num);
    // 🔴 THE NODES TOO, as on the uncompressed path (security review of 31/10/2026): the per-node charge
    // was only applied to `objectAtOffset`, so the COMPRESSED path — the one a hostile input builds
    // for a few kilobytes — remained uncovered.
    spend(member.nodes * HEAP_PER_NODE);
    return member.value;
  }

  /** One object by number, read once. `undefined` when the table does not place it. */
  function objectOf(num: number): PdfValue | undefined {
    if (objects.has(num)) return objects.get(num);
    const entry = xref.entries.get(num);
    if (entry === undefined) return undefined;
    if (reading.has(num)) throw new PdfObjectsRefusal("length-unresolved", num);
    // §7.3.8.2: an indirect `/Length` goes back down into `objectOf`, and that descent is RECURSIVE. Without
    // this count, a thousand streams each of whose `/Length` points at the next — 75 KB of file — overflowed the
    // CALL STACK: a `RangeError`, not a refusal (security review of 31/10/2026). `MAX_REF_HOPS` counted
    // only the hops of `resolve`, and the `reading` set only the cycles.
    if (reading.size >= MAX_REF_HOPS) throw new PdfObjectsRefusal("ref-hops", num);
    reading.add(num);
    try {
      const value =
        entry.kind === "offset"
          ? objectAtOffset(num, entry.offset, entry.gen)
          : objectInContainer(num, entry.container);
      objects.set(num, value);
      return value;
    } finally {
      reading.delete(num);
    }
  }

  let readPages: readonly PdfPageEntry[] | undefined;
  const pages = (): readonly PdfPageEntry[] => (readPages ??= walkPageTree(lookups, xref.trailer));

  return { trailer: () => xref.trailer, resolve, dictOf, streamBytes, rawStreamBytes, imageStreamOf, pages };
}

/** The one filter of a stream, as a name: `/Filter /X`, or `/Filter [/X]` (a one-element array, the same thing). */
/** The name a value holds, or `undefined` for anything else. */
const nameOfValue = (value: PdfValue | undefined): string | undefined =>
  value?.kind === "name" ? value.value : undefined;

export function singleFilterOf(doc: PdfObjectsDocument, dict: ReadonlyMap<string, PdfValue>): string | undefined {
  const filter = doc.resolve(dict.get("Filter"));
  if (filter?.kind === "array")
    return filter.items.length === 1 ? nameOfValue(doc.resolve(filter.items[0])) : undefined;
  return nameOfValue(filter);
}

/** The IMAGE filter of a picture: alone, or the LAST of a chain whose other filters the stream reader undoes itself
 *  (`imageStreamOf`). `undefined` when the picture carries no image filter at all — then its bytes are samples, and
 *  `streamBytes` reads them. What an image decoder must ask instead of `singleFilterOf`, which answers `undefined` for
 *  a chain of two and left a Flate-wrapped JPEG unread by everyone (03/11/2026). */
export function imageFilterOf(doc: PdfObjectsDocument, dict: ReadonlyMap<string, PdfValue>): string | undefined {
  const filter = doc.resolve(dict.get("Filter"));
  const last = filter?.kind === "array" ? nameOfValue(doc.resolve(filter.items.at(-1))) : nameOfValue(filter);
  return last !== undefined && IMAGE_FILTERS.has(last) ? last : undefined;
}
