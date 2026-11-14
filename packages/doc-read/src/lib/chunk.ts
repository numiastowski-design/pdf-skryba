/** Splits a list into consecutive groups of at most `size` items, in order. A LEAF module: it imports nothing.
 *  NOT here: what a group means (a batch of pages, of records, of audit lines) or its size: each caller names its own.
 *  Called by: `extractor/pdf-scanned.ts`, `orchestrator/publish-batch.ts`, `adapters/forge-audit-store.ts`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
