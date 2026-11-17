/** A minimal, dependency-free XML tree, parser and serialiser: the one place everything Confluence-shaped goes through
 *  to build elements, escape text and attributes, and parse a fragment back. One escaping and self-closing
 *  implementation, not two.
 *  Decides: storage format is XML (namespaced `ac:`/`ri:` elements, meaningful self-closing tags), not HTML5: an HTML
 *  parser would misparse it. Deliberately narrow: elements, attributes, text, CDATA sections. No DTD, no processing
 *  instructions, no namespace resolution (tag and attribute names are opaque strings, e.g. "ac:image").
 *  NOT here: what a page's XML says (`renderer/storage.ts`), nor the normalisation used for comparison
 *  (`core/canonicalize.ts`).
 *  Called by: `renderer/storage.ts`, `core/canonicalize.ts`, `adapters/forge-confluence-api.ts`,
 *  `adapters/google-auth.ts`. */

export interface XmlElement {
  readonly type: "element";
  readonly tag: string;
  readonly attrs: readonly (readonly [string, string])[];
  readonly children: readonly XmlNode[];
}

export interface XmlText {
  readonly type: "text";
  readonly value: string;
  /** Serialize wrapped in `<![CDATA[...]]>` instead of entity-escaping. */
  readonly cdata?: boolean;
}

export type XmlNode = XmlElement | XmlText;

export const element = (
  tag: string,
  attrs: Record<string, string> = {},
  children: readonly XmlNode[] = [],
): XmlElement => ({ type: "element", tag, attrs: Object.entries(attrs), children });

export const text = (value: string): XmlText => ({ type: "text", value });
export const cdata = (value: string): XmlText => ({ type: "text", value, cdata: true });

// ---------------------------------------------------------------------------
// Serialization

// Exported (04/09/2026, security audit finding): also reused to escape untrusted values before they go into an HTML
// text node, because the same three characters need escaping there as in an XML one ("one escaping implementation,
// not two").
//
// TEXT NODES ONLY, and the distinction is not pedantic (07/09/2026): this
// leaves `"` and `'` untouched, which is correct between tags and WRONG the
// moment the value lands in an attribute value, where a quote closes the
// attribute and reopens the injection. Use `escapeAttr` below for those, and
// note that neither function makes a value safe inside a `<script>`:
// a value belongs in JSON there, or nowhere.
/**
 * Characters that XML 1.0 does NOT admit, and that no escaping can save
 * (spec §2.2: `Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | …`). A numeric
 * reference does not redeem them either — `&#1;` is just as invalid as
 * the bare byte. The only conforming treatment is REMOVAL.
 *
 * Not a theoretical precaution (found on 08/09/2026, fixture
 * `13-Police-Sans-CMap.pdf`): control characters extracted from a PDF font
 * without a Unicode map reached the published XHTML, the body of a request
 * to Confluence.
 *
 * Remove here, at the last moment, rather than in the extractor: it is the
 * serializer that is responsible for never producing an invalid
 * document, whatever the origin of the string. A filter placed upstream
 * would let through the next source we have not foreseen.
 *
 * ⚠️ This removal makes the document VALID, it does not make it GOOD. Text
 * extracted as control characters stays unreadable once cleaned: detecting
 * the noise (and switching to OCR) is not handled here, and this filter is
 * not an answer to it.
 */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * ISOLATED surrogates are also outside the `Char` production: the
 * range D800-DFFF is not in it, only the PAIR forming an astral character
 * is valid. Two passes, one for a high without a low, the other for a low
 * without a high — a correctly paired emoji goes through intact.
 *
 * Found on 08/09/2026 while fixing the control characters: the fuzz corpus
 * ALREADY contained some, and nothing had ever flagged it — our own parser
 * tolerates them.
 */
const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g;
const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export const stripInvalidXmlChars = (value: string): string =>
  value.replace(INVALID_XML_CHARS, "").replace(LONE_HIGH_SURROGATE, "").replace(LONE_LOW_SURROGATE, "");

export const escapeText = (value: string): string =>
  stripInvalidXmlChars(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Exported (04/09/2026, fuzz finding): callers that need to find a serialized
// attribute value inside already-rendered XHTML must search for the ESCAPED
// form, the same one this module actually writes — never reimplement escaping
// a second time ("one escaping implementation, not two").
export const escapeAttr = (value: string): string => escapeText(value).replace(/"/g, "&quot;");

export const serializeXml = (node: XmlNode): string => {
  if (node.type === "text") {
    // CDATA bypasses escaping but NOT validity: a forbidden character
    // stays forbidden inside a CDATA section.
    return node.cdata ? `<![CDATA[${stripInvalidXmlChars(node.value)}]]>` : escapeText(node.value);
  }
  const attributesText = node.attrs.map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join("");
  if (node.children.length === 0) return `<${node.tag}${attributesText}/>`;
  return `<${node.tag}${attributesText}>${node.children.map(serializeXml).join("")}</${node.tag}>`;
};

/** The three prohibitions of §2.2 in a single pattern, WITHOUT `g`: we want
 *  the position of the first one, not a stateful scan. */
const ANY_INVALID_XML_CHAR =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * A NET, not the fix — the fix is the removal above (08/09/2026).
 *
 * If a forbidden character survives to here, some serialization path bypassed
 * `stripInvalidXmlChars`. We want to know, and above all we must not publish:
 * carrying on after detection would send invalid XML to the Confluence API,
 * exactly what this net exists to prevent. A log would go nowhere — this module
 * is pure, with no I/O, and a log nobody reads is not a net.
 *
 * A bare `Error`, not an `AppError`: this module already throws bare `Error`s
 * (`mismatched closing tag`, `unterminated element`), and a misleading error
 * code would be worse than none for a deterministic defect of ours.
 *
 * ⚠️ NO DATA CAN REACH THIS NET. The only path that parsed what Confluence
 * RETURNS in order to write it back (`stripBanner`, at detach) disappeared on
 * 30/09/2026 with the banner: the net now fires only on a defect of OUR code —
 * a serialization path that would bypass `stripInvalidXmlChars`.
 *
 * HERE AND NOT IN `serializeXml`: the latter is RECURSIVE, so the check there
 * would rescan the output of every subtree — quadratic. One scan of the final
 * string.
 *
 * NO CHECK ON TAG NAMES, and it is not an oversight: the serializer emits a
 * TREE whose names are literals of our code, never data. An illegal name cannot
 * be expressed through this path. Do not add one « to be safe ».
 *
 * NO CLIENT CONTENT IN THE MESSAGE: the character's code and its position,
 * nothing else. The message may be displayed or logged, and carries no client
 * content (CLAUDE.md).
 */
export const serializeXmlFragment = (nodes: readonly XmlNode[]): string => {
  const serialized = nodes.map(serializeXml).join("");
  const found = ANY_INVALID_XML_CHAR.exec(serialized);
  if (found) {
    const code = serialized.codePointAt(found.index) ?? 0;
    throw new Error(
      `serializeXmlFragment: invalid XML 1.0 character U+${code.toString(16).toUpperCase().padStart(4, "0")} at offset ${found.index}`,
    );
  }
  return serialized;
};

// ---------------------------------------------------------------------------
// Parsing

const NAME_PATTERN = "[^\\s=/>]+";
const ATTRIBUTE_PATTERN = new RegExp(`(${NAME_PATTERN})\\s*=\\s*"([^"]*)"|(${NAME_PATTERN})\\s*=\\s*'([^']*)'`, "g");

// The full HTML4 named character reference set (W3C HTML 4.01 spec, §24).
// Decoding these here is what lets canonicalizeStorage() compare an accented
// character spelled as a named reference with the same character as raw UTF-8,
// without needing to change what the renderer sends.
const HTML4_ENTITIES: Record<string, number> = {
  // The 5 XML predefined entities (apos is not in HTML 4, §24, but this parser
  // reads XML — storage format — so it must always be decoded regardless).
  quot: 34,
  amp: 38,
  lt: 60,
  gt: 62,
  apos: 39,
  nbsp: 160,
  iexcl: 161,
  cent: 162,
  pound: 163,
  curren: 164,
  yen: 165,
  brvbar: 166,
  sect: 167,
  uml: 168,
  copy: 169,
  ordf: 170,
  laquo: 171,
  not: 172,
  shy: 173,
  reg: 174,
  macr: 175,
  deg: 176,
  plusmn: 177,
  sup2: 178,
  sup3: 179,
  acute: 180,
  micro: 181,
  para: 182,
  middot: 183,
  cedil: 184,
  sup1: 185,
  ordm: 186,
  raquo: 187,
  frac14: 188,
  frac12: 189,
  frac34: 190,
  iquest: 191,
  Agrave: 192,
  Aacute: 193,
  Acirc: 194,
  Atilde: 195,
  Auml: 196,
  Aring: 197,
  AElig: 198,
  Ccedil: 199,
  Egrave: 200,
  Eacute: 201,
  Ecirc: 202,
  Euml: 203,
  Igrave: 204,
  Iacute: 205,
  Icirc: 206,
  Iuml: 207,
  ETH: 208,
  Ntilde: 209,
  Ograve: 210,
  Oacute: 211,
  Ocirc: 212,
  Otilde: 213,
  Ouml: 214,
  times: 215,
  Oslash: 216,
  Ugrave: 217,
  Uacute: 218,
  Ucirc: 219,
  Uuml: 220,
  Yacute: 221,
  THORN: 222,
  szlig: 223,
  agrave: 224,
  aacute: 225,
  acirc: 226,
  atilde: 227,
  auml: 228,
  aring: 229,
  aelig: 230,
  ccedil: 231,
  egrave: 232,
  eacute: 233,
  ecirc: 234,
  euml: 235,
  igrave: 236,
  iacute: 237,
  icirc: 238,
  iuml: 239,
  eth: 240,
  ntilde: 241,
  ograve: 242,
  oacute: 243,
  ocirc: 244,
  otilde: 245,
  ouml: 246,
  divide: 247,
  oslash: 248,
  ugrave: 249,
  uacute: 250,
  ucirc: 251,
  uuml: 252,
  yacute: 253,
  thorn: 254,
  yuml: 255,
  fnof: 402,
  Alpha: 913,
  Beta: 914,
  Gamma: 915,
  Delta: 916,
  Epsilon: 917,
  Zeta: 918,
  Eta: 919,
  Theta: 920,
  Iota: 921,
  Kappa: 922,
  Lambda: 923,
  Mu: 924,
  Nu: 925,
  Xi: 926,
  Omicron: 927,
  Pi: 928,
  Rho: 929,
  Sigma: 931,
  Tau: 932,
  Upsilon: 933,
  Phi: 934,
  Chi: 935,
  Psi: 936,
  Omega: 937,
  alpha: 945,
  beta: 946,
  gamma: 947,
  delta: 948,
  epsilon: 949,
  zeta: 950,
  eta: 951,
  theta: 952,
  iota: 953,
  kappa: 954,
  lambda: 955,
  mu: 956,
  nu: 957,
  xi: 958,
  omicron: 959,
  pi: 960,
  rho: 961,
  sigmaf: 962,
  sigma: 963,
  tau: 964,
  upsilon: 965,
  phi: 966,
  chi: 967,
  psi: 968,
  omega: 969,
  thetasym: 977,
  upsih: 978,
  piv: 982,
  bull: 8226,
  hellip: 8230,
  prime: 8242,
  Prime: 8243,
  oline: 8254,
  frasl: 8260,
  weierp: 8472,
  image: 8465,
  real: 8476,
  trade: 8482,
  alefsym: 8501,
  larr: 8592,
  uarr: 8593,
  rarr: 8594,
  darr: 8595,
  harr: 8596,
  crarr: 8629,
  lArr: 8656,
  uArr: 8657,
  rArr: 8658,
  dArr: 8659,
  hArr: 8660,
  forall: 8704,
  part: 8706,
  exist: 8707,
  empty: 8709,
  nabla: 8711,
  isin: 8712,
  notin: 8713,
  ni: 8715,
  prod: 8719,
  sum: 8721,
  minus: 8722,
  lowast: 8727,
  radic: 8730,
  prop: 8733,
  infin: 8734,
  ang: 8736,
  and: 8743,
  or: 8744,
  cap: 8745,
  cup: 8746,
  int: 8747,
  there4: 8756,
  sim: 8764,
  cong: 8773,
  asymp: 8776,
  ne: 8800,
  equiv: 8801,
  le: 8804,
  ge: 8805,
  sub: 8834,
  sup: 8835,
  nsub: 8836,
  sube: 8838,
  supe: 8839,
  oplus: 8853,
  otimes: 8855,
  perp: 8869,
  sdot: 8901,
  lceil: 8968,
  rceil: 8969,
  lfloor: 8970,
  rfloor: 8971,
  lang: 9001,
  rang: 9002,
  loz: 9674,
  spades: 9824,
  clubs: 9827,
  hearts: 9829,
  diams: 9830,
  OElig: 338,
  oelig: 339,
  Scaron: 352,
  scaron: 353,
  Yuml: 376,
  circ: 710,
  tilde: 732,
  ensp: 8194,
  emsp: 8195,
  thinsp: 8201,
  zwnj: 8204,
  zwj: 8205,
  lrm: 8206,
  rlm: 8207,
  ndash: 8211,
  mdash: 8212,
  lsquo: 8216,
  rsquo: 8217,
  sbquo: 8218,
  ldquo: 8220,
  rdquo: 8221,
  bdquo: 8222,
  dagger: 8224,
  Dagger: 8225,
  permil: 8240,
  lsaquo: 8249,
  rsaquo: 8250,
  euro: 8364,
};

/** A numeric reference past Unicode becomes U+FFFD, never a throw: one hostile reference in a
 *  page must not fail the whole document. A lone surrogate does not throw either and stays decoded as written
 *  (locked by `xml.test.ts`, « décode aussi une référence à un surrogate isolé »). */
const decodeCharacterReference = (code: number): string =>
  !Number.isFinite(code) || code > 0x10ffff ? "�" : String.fromCodePoint(code);

/** The ONE entity decoder (numeric and HTML4 named), a single pass: « &#38;lt; » gives the literal « &lt; », not « < ».
 *  An unknown name is kept as written. Shared with the pipeline's page readers. */
export const decodeEntities = (value: string): string =>
  value.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (reference, hexDigits: string | undefined, decimalDigits: string | undefined, entityName: string | undefined) => {
      if (hexDigits !== undefined) return decodeCharacterReference(Number.parseInt(hexDigits, 16));
      if (decimalDigits !== undefined) return decodeCharacterReference(Number.parseInt(decimalDigits, 10));
      // Own members only: `&constructor;` must stay as written, not find Object.prototype's.
      const codePoint = Object.hasOwn(HTML4_ENTITIES, entityName!) ? HTML4_ENTITIES[entityName!] : undefined;
      return codePoint === undefined ? reference : String.fromCodePoint(codePoint);
    },
  );

class ParseError extends Error {}

/** Parses a well-formed XML fragment (no single required root) into sibling nodes. */
export const parseXmlFragment = (source: string): XmlNode[] => {
  let position = 0;
  const sourceLength = source.length;

  const parseAttributes = (raw: string): [string, string][] => {
    const attributes: [string, string][] = [];
    for (const match of raw.matchAll(ATTRIBUTE_PATTERN)) {
      const name = match[1] ?? match[3];
      const value = match[2] ?? match[4] ?? "";
      if (name) attributes.push([name, decodeEntities(value)]);
    }
    return attributes;
  };

  /** Reads the end tag at `position` (on `</`) and checks it closes `expectedClosingTag`; leaves `position` after it. */
  const consumeEndTag = (expectedClosingTag: string | null): void => {
    const closeIndex = source.indexOf(">", position);
    if (closeIndex < 0) throw new ParseError("unterminated closing tag");
    const closedTag = source.slice(position + 2, closeIndex).trim();
    if (closedTag !== expectedClosingTag) {
      throw new ParseError(`mismatched closing tag </${closedTag}>, expected </${expectedClosingTag ?? ""}>`);
    }
    position = closeIndex + 1;
  };

  /** Reads the start or empty-element tag at `position` (on `<`) and, for a start tag, everything up to its end tag. */
  const parseElement = (): XmlNode => {
    const closeIndex = source.indexOf(">", position);
    if (closeIndex < 0) throw new ParseError("unterminated tag");
    const isSelfClosing = source[closeIndex - 1] === "/";
    const tagContent = source.slice(position + 1, isSelfClosing ? closeIndex - 1 : closeIndex);
    const nameMatch = /^[^\s/]+/.exec(tagContent);
    if (!nameMatch) throw new ParseError(`malformed tag: <${tagContent}>`);
    const tag = nameMatch[0];
    const attrs = parseAttributes(tagContent.slice(tag.length));
    position = closeIndex + 1;
    if (isSelfClosing) return { type: "element", tag, attrs, children: [] };
    return { type: "element", tag, attrs, children: parseNodes(tag) };
  };

  const parseNodes = (expectedClosingTag: string | null): XmlNode[] => {
    const nodes: XmlNode[] = [];
    let textStart = position;

    const flushPendingText = (end: number): void => {
      if (end > textStart) {
        const raw = source.slice(textStart, end);
        if (raw.length > 0) nodes.push(text(decodeEntities(raw)));
      }
    };

    while (position < sourceLength) {
      if (source.startsWith("<!--", position)) {
        flushPendingText(position);
        const closeIndex = source.indexOf("-->", position + 4);
        if (closeIndex < 0) throw new ParseError("unterminated comment");
        position = closeIndex + 3;
        textStart = position;
        continue;
      }
      if (source.startsWith("<![CDATA[", position)) {
        flushPendingText(position);
        const closeIndex = source.indexOf("]]>", position + 9);
        if (closeIndex < 0) throw new ParseError("unterminated CDATA section");
        nodes.push(cdata(source.slice(position + 9, closeIndex)));
        position = closeIndex + 3;
        textStart = position;
        continue;
      }
      if (source[position] !== "<") {
        position++;
        continue;
      }
      flushPendingText(position);
      if (source[position + 1] === "/") {
        consumeEndTag(expectedClosingTag);
        return nodes;
      }
      nodes.push(parseElement());
      textStart = position;
    }
    flushPendingText(position);
    if (expectedClosingTag !== null) throw new ParseError(`unterminated element <${expectedClosingTag}>`);
    return nodes;
  };

  return parseNodes(null);
};
