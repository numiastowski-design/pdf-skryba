/** THE FONT-NAME BRIDGE: the "scope + name" key of each `Tf` of a stream, shared by OUR font objects
 *  (`./pdf-symbol-page.ts`) and our operators (`./pdf-ops-ours.ts`). HISTORIC (pdf.js, removed 01/11/2026): pdf.js named
 *  its fonts `g_d3_f1` where a page says `/F1`, and this bridge paired the two.
 *  Decides: that the key is read by walking the stream's `Tf` in order, forms unrolled — the caller says what a form name
 *  resolves to (`FormResolver`), and `ResolvedForm` is a UNION of its BYTES, tokenized here, or of its OPERATORS when the
 *  caller already holds them: a form drawn ten times is tokenized once per document (performance review of 02/11/2026).
 *  The old pairing with pdf.js's
 *  operator list was measured: 7 211 pages out of 7 231 had text-operator sequences that matched one for one
 *  (`tools/poc/glyph-source-shadow.ts` (deleted, see git history), 31/10/2026).
 *  🔴 The old bridge was ALL OR NOTHING: if the two lists did not hold the same number of `Tf`, it was EMPTY and the
 *  caller kept pdf.js's objects. A half-right bridge would have answered the fields of one font for another — a weight
 *  or a Type 3 scale taken from the neighbour — without any test seeing it.
 *  WHY THE KEY CARRIES A SCOPE: a resource name is unique only within ITS scope, and an XObject form brings its own;
 *  pdf.js named at DOCUMENT level.
 *  NOT here: the fields themselves (`./pdf-font-objects.ts`), the glyphs (`./pdf-glyph-source.ts`), the boundary
 *  that chooses (`./pdf-source.ts`).
 *  Called by: `extractor/pdf-symbol-page.ts` (the font objects) and `extractor/pdf-ops-ours.ts` (the operators), the two
 *  readers the key pairs; `extractor/pdf-source.ts` does not call it. */

import { chargeFormCall } from "./pdf-glyph-source";
import { readContentOps, type ContentOp } from "./pdf-objects/content";
import type { PdfValue } from "./pdf-objects/objects";

const nameOf = (value: PdfValue | undefined): string | undefined => (value?.kind === "name" ? value.value : undefined);

/** §8.10: as many levels of nested forms as our glyph reader follows (`pdf-glyph-source.ts`). */
const MAX_FORM_DEPTH = 8;

/** The separator of a "scope + name" key: a character a resource name cannot carry (a NUL byte). */
export const SCOPE_SEPARATOR = "\u0000";

/** A resolved form: its stream, and its SCOPE — the form's unique path from the page. */
export type ResolvedForm = { readonly scope: string } & (
  | { readonly data: Uint8Array } // the form's bytes, to tokenize here
  | { readonly ops: readonly ContentOp[] } // its operators, when the resolver already has them tokenized (once per document)
);

/** Resolves the name of a form called from the scope `scope` (the page has the scope `""`). */
export type FormResolver = (name: string, scope: string) => ResolvedForm | undefined;

/** The `Tf` of a stream, tied to their scope. Forms unroll at EVERY level (§8.10.1): a form nested in a form is
 *  called by the form, with the latter's resources. */
export function ourFontNamesIn(content: Uint8Array, resolve: FormResolver): (string | undefined)[] {
  const walk: Walk = { resolve, budget: { forms: 0 }, into: [] };
  ourFontKeys(content, walk, "", 0);
  return walk.into;
}

/** What one page's walk shares: how to resolve a form, the form budget of the page, and the keys found so far. */
interface Walk {
  readonly resolve: FormResolver;
  readonly budget: { forms: number };
  readonly into: (string | undefined)[];
}

/** The `Tf` of a stream, tied to their SCOPE: the page (`""`) or the form that holds them (`form:<name>`, then
 *  `form:<name>/form:<name>` for a nested form).
 *  🔴 A form has its own resources (§8.10.1): its `Tf /F1` is not the page's font `/F1`. Without this tie, the fonts
 *  declared inside forms — the case of most PDFs exported by Canva — were not found, and their weight became
 *  "unknown" (measured 31/10/2026 on `26-Livret-Accueil-Canva`). */
function ourFontKeys(content: Uint8Array | readonly ContentOp[], walk: Walk, scope: string, depth: number): void {
  for (const { op, operands } of content instanceof Uint8Array ? readContentOps(content) : content) {
    if (op === "Tf") {
      const name = nameOf(operands[0]);
      walk.into.push(name === undefined ? undefined : `${scope}${SCOPE_SEPARATOR}${name}`);
    } else if (op === "Do" && depth < MAX_FORM_DEPTH) {
      const form = walk.resolve(nameOf(operands[0]) ?? "", scope);
      if (form === undefined) continue;
      // Counted across the whole page, like the two other readers that unroll forms (a loop, not `push(...)`: a spread of
      // a very long list is a stack overflow, not a refusal).
      chargeFormCall(walk.budget);
      ourFontKeys("ops" in form ? form.ops : form.data, walk, form.scope, depth + 1);
    }
  }
}
