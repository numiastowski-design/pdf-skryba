/** The canonical namespace prefixes of the Office vocabularies and the XML nesting bound, a LEAF module imported by
 *  `ooxml/xml.ts` and by our XML reader alike, so the reader never imports `ooxml/xml.ts` (which builds its
 *  parser at load: the cycle would run it before `class XMLParser` exists, `xml/import-direction.test.ts`).
 *  NOT here: the parsing, the tree walk and the rewriting itself (`ooxml/xml.ts#canonicalize`), the entity
 *  bounds; this module imports nothing.
 *  Called by: `ooxml/xml.ts` (which re-exports all of it, so its importers do not change), `xml/tree.ts`,
 *  `xml/namespaces.ts`. */

/* eslint-disable sonarjs/no-clear-text-protocols -- the http:// strings are OOXML namespace URIs, matched byte for byte; nothing is ever fetched from them */

/** The element nesting past which a part is refused. The parser checks it when
 *  an element opens with this many already open, so a part is read up to 513
 *  levels (514 when the deepest is a self-closing tag); `xml/tree.ts` bites at
 *  the same place (`xml/guards.test.ts`). Starting value to calibrate
 *  (review of 27/09/2026 night, finding 7): three real documents measured the
 *  same night reach 8 (docx-reel/08), 18 (docx-reel/10) and 16 (gdoc-docx/10)
 *  levels; a table nested in a cell costs three. Past it the parser refuses
 *  the part, which the package layer turns into « damaged »: the recursive
 *  walks (`xml.ts#canonicalize`, `body.ts#storyUnits`…) never meet a depth
 *  that could exhaust the stack — a test reads a document ~500 deep through
 *  the whole reader. Before this constant the parser's own default (100)
 *  held, unnamed: a library upgrade could have dropped it in silence. */
export const MAX_XML_DEPTH = 512;

/**
 * The canonical prefix of each namespace the reader understands, keyed by
 * namespace URI. XML Namespaces lets a producer bind ANY prefix to a
 * namespace; only the URI identifies it. ECMA-376 also has a Strict
 * conformance class with its own namespace URIs; both map to the same
 * prefix so the rest of the reader never sees the difference.
 */
export const CANONICAL_PREFIX: Record<string, string> = {
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main": "w",
  "http://purl.oclc.org/ooxml/wordprocessingml/main": "w",
  "http://schemas.openxmlformats.org/presentationml/2006/main": "p",
  "http://purl.oclc.org/ooxml/presentationml/main": "p",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships": "r",
  "http://purl.oclc.org/ooxml/officeDocument/relationships": "r",
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing": "wp",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing": "wp",
  "http://schemas.openxmlformats.org/drawingml/2006/main": "a",
  "http://purl.oclc.org/ooxml/drawingml/main": "a",
  "http://schemas.openxmlformats.org/drawingml/2006/picture": "pic",
  "http://purl.oclc.org/ooxml/drawingml/picture": "pic",
  "http://schemas.openxmlformats.org/officeDocument/2006/math": "m",
  "http://purl.oclc.org/ooxml/officeDocument/math": "m",
  "http://schemas.openxmlformats.org/markup-compatibility/2006": "mc",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingShape": "wps",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup": "wpg",
  "urn:schemas-microsoft-com:vml": "v",
  "http://schemas.openxmlformats.org/drawingml/2006/chart": "c",
  "http://purl.oclc.org/ooxml/drawingml/chart": "c",
  // SmartArt: the data model (ECMA-376 Part 1 §21.4) and Office's drawing cache.
  "http://schemas.openxmlformats.org/drawingml/2006/diagram": "dgm",
  "http://purl.oclc.org/ooxml/drawingml/diagram": "dgm",
  "http://schemas.microsoft.com/office/drawing/2008/diagram": "dsp",
  "http://schemas.openxmlformats.org/package/2006/relationships": "rel",
  "http://schemas.openxmlformats.org/package/2006/content-types": "ct",
  // Spreadsheets (revue HIGH 28/09 soir, constat 5). Excel spells the main
  // namespace as the DEFAULT one (bare tags) — the canonical spelling is
  // therefore the EMPTY prefix, and a producer that binds one gets it
  // stripped. Excel spells the drawing namespace `xdr:`.
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main": "",
  "http://purl.oclc.org/ooxml/spreadsheetml/main": "",
  "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing": "xdr",
  "http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing": "xdr",
};

/** The canonical prefix of a namespace URI, own keys only: « toString » or « constructor » is no namespace. */
export const canonicalPrefixOf = (uri: string): string | undefined => (Object.hasOwn(CANONICAL_PREFIX, uri) ? CANONICAL_PREFIX[uri] : undefined);

/** What `renamed` reads of a scope: the namespace URI bound to a prefix (`""`: the default namespace). */
export interface PrefixScope {
  get(prefix: string): string | undefined;
}

/** A name with its producer's prefix replaced by the canonical one. Exported so `xml/namespaces.ts` checks the
 *  collisions of THIS mapping, one definition (attributes become object keys below: two of one name lose a value). */
export const renamed = (name: string, scope: PrefixScope, isAttribute: boolean): string => {
  const colon = name.indexOf(":");
  if (colon < 0) {
    // An unprefixed ATTRIBUTE is in no namespace (XML Namespaces §6.2); an
    // unprefixed element is in the default namespace.
    if (isAttribute) return name;
    const uri = scope.get("");
    const canonical = uri === undefined ? undefined : canonicalPrefixOf(uri);
    return canonical ? `${canonical}:${name}` : name;
  }
  const prefix = name.slice(0, colon);
  if (prefix === "xml" || prefix === "xmlns") return name;
  const uri = scope.get(prefix);
  const canonical = uri === undefined ? undefined : canonicalPrefixOf(uri);
  if (canonical === undefined) return name;
  // An EMPTY canonical prefix (spreadsheetml) strips the producer's one.
  return canonical === "" ? name.slice(colon + 1) : `${canonical}:${name.slice(colon + 1)}`;
};
