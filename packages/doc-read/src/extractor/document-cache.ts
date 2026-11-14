/** ONE cache per document, bounded in bytes, that every reader of the document draws on.
 *  Decides: what stays in memory between reads of a document: the decoded pages and forms, the tokenized forms, the decoded pictures and
 *  soft masks. The total of their sizes never passes `MAX_DECODED_STREAM_BYTES`; room is made by dropping the entries not used for longest,
 *  WHATEVER their kind, so a logo painted on every page stays while the contents of pages already read go. A value that does not fit alone is
 *  returned and not kept; what is dropped is recomputed next time, never refused. An `undefined` value costs nothing.
 *  Why one cache and not one per reader: three caches of 64 MB held 192 MB at worst, and a pool shared between them counted bytes of a cache
 *  the garbage collector had already taken and let one kind starve the others (performance review of 02/11/2026). The cache belongs to the
 *  DOCUMENT (`documentCacheOf`), so it lives and dies with it.
 *  NOT here: what the values are or how big (the caller says), the work that makes them.
 *  Called by: `pdf-page-content.ts`, `pdf-source.ts`, `pdf-embedded-images.ts`. */

import { MAX_DECODED_STREAM_BYTES } from "./pdf-objects/bounds";

interface Entry {
  readonly kind: symbol;
  readonly key: unknown;
  readonly value: unknown;
  readonly size: number;
}

export class DocumentCache {
  /** Entries by kind then key. */
  private readonly byKind = new Map<symbol, Map<unknown, Entry>>();
  /** All the entries, the least recently used first (a `Map` keeps insertion order; a hit re-inserts). */
  private readonly used = new Map<Entry, true>();
  private held = 0;

  constructor(private readonly cap: number = MAX_DECODED_STREAM_BYTES) {}

  private forget(entry: Entry): void {
    this.byKind.get(entry.kind)?.delete(entry.key);
    this.used.delete(entry);
    this.held -= entry.size;
  }

  /** The kept value of `key` in `kind`, or `compute()`'s, kept if it fits. `sizeOf` is called once, after `compute`. */
  getOrCompute<V>(kind: symbol, key: unknown, sizeOf: (value: V) => number, compute: () => V): V {
    const known = this.byKind.get(kind)?.get(key);
    if (known !== undefined) {
      if (known.size > 0) {
        this.used.delete(known);
        this.used.set(known, true);
      }
      return known.value as V;
    }
    const value = compute();
    // `compute` may have stored this very key (a re-entrant call): its entry is replaced, so its size leaves the total first.
    const reentrant = this.byKind.get(kind)?.get(key);
    if (reentrant !== undefined) this.forget(reentrant);
    const size = value === undefined ? 0 : sizeOf(value);
    if (size > this.cap) return value;
    for (const oldest of this.used.keys()) {
      if (this.held + size <= this.cap) break;
      this.forget(oldest);
    }
    const entry: Entry = { kind, key, value, size };
    let entries = this.byKind.get(kind);
    if (entries === undefined) {
      entries = new Map();
      this.byKind.set(kind, entries);
    }
    entries.set(key, entry);
    // An entry that costs nothing is not in the order of use: it frees nothing when dropped, so walking past it at each eviction would be
    // work for nothing (50 000 unfiltered pages made 2.5 billion steps). It stays as long as the document, a hundred bytes each.
    if (size > 0) this.used.set(entry, true);
    this.held += size;
    return value;
  }

  /** The total size kept (for tests). */
  get size(): number {
    return this.held;
  }
}

const CACHES = new WeakMap<object, DocumentCache>();

/** The cache of a document (any object that stands for it). */
export function documentCacheOf(document: object): DocumentCache {
  let cache = CACHES.get(document);
  if (cache === undefined) {
    cache = new DocumentCache();
    CACHES.set(document, cache);
  }
  return cache;
}
