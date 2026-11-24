/** The font objects of a page, read from OUR document (the font's dictionary), keyed by our font key: `scope + SCOPE_SEPARATOR
 *  + name`, the key our operators' `setFont` carries (`pdf-ops-ours.ts`). Each font is read in the resources of ITS scope:
 *  the page, or the form that declares it, at any nesting (ISO 32000-1 §8.10.1).
 *  Decides: nothing. NOT here: the verdict of a font (`./pdf-symbol-verdict.ts`), the fields of a font object
 *  (`./pdf-font-objects.ts`), the key's parts (`./pdf-font-bridge.ts`).
 *  Called by: `extractor/pdf-source.ts#readPageText`, `pdf-symbol-page.test.ts`. */

import { ourFontNamesIn, SCOPE_SEPARATOR, type FormResolver } from "./pdf-font-bridge";
import { ourFontObject, type OurFontObject } from "./pdf-font-objects";
import type { PdfObjectsDocument, PdfPageEntry } from "./pdf-objects/document";
import type { PdfDict } from "./pdf-objects/objects";
import { partOrAbsent } from "./pdf-objects/refusal";
import type { ContentOp } from "./pdf-objects/content";
import { pageContentOf, parsedFormOf } from "./pdf-page-content";

/** The font objects of a page, by our font key. A font that cannot be read is left out (ignorance: no verdict, no weight). */
export function fontObjectsOfPage(doc: PdfObjectsDocument, page: PdfPageEntry): ReadonlyMap<string, OurFontObject> {
  // The resources that apply to each scope: the page's, and each form's (its own, or the calling scope's when it has none).
  const resourcesOf = new Map<string, PdfDict | undefined>([["", page.resources]]);
  const resolve: FormResolver = (name, scope) => {
    const parent = resourcesOf.get(scope);
    const xobjects = doc.dictOf(parent?.get("XObject"));
    // An XObject we cannot read is not walked: the operator reader counts it as an unread picture (`pdf-ops-ours.ts`,
    // decision of 24/11/2026).
    const target = partOrAbsent(() => doc.resolve(xobjects?.get(name)));
    if (target?.kind !== "stream") return undefined;
    if ((doc.resolve(target.dict.get("Subtype")) as { value?: string } | undefined)?.value !== "Form") return undefined;
    let ops: readonly ContentOp[];
    try {
      ops = parsedFormOf(doc, target);
    } catch {
      // A refusal of our reader on ONE form: it is not walked, and its fonts stay unknown.
      return undefined;
    }
    const childScope = scope === "" ? `form:${name}` : `${scope}/form:${name}`;
    resourcesOf.set(childScope, doc.dictOf(target.dict.get("Resources")) ?? parent);
    return { ops, scope: childScope };
  };
  // Walking the content visits every form that paints text, so that its resources are in `resourcesOf`.
  ourFontNamesIn(pageContentOf(doc, page), resolve);

  const objects = new Map<string, OurFontObject>();
  // One object per font DICTIONARY: several resource names naming the same font share it, which is how the runs tell
  // « the same font under another name » from a change of font (`pdf-source.ts`, `glyph-runs.ts#GlyphRunOptions.sameFont`).
  const byDict = new Map<PdfDict, OurFontObject>();
  for (const [scope, resources] of resourcesOf) {
    const fonts = doc.dictOf(resources?.get("Font"));
    for (const key of fonts?.keys?.() ?? []) {
      const font = doc.dictOf(fonts?.get(key));
      if (font === undefined) continue;
      let object = byDict.get(font);
      if (object === undefined) {
        object = ourFontObject(doc, font);
        byDict.set(font, object);
      }
      objects.set(`${scope}${SCOPE_SEPARATOR}${key}`, object);
    }
  }
  return objects;
}
