/** Namespace checks of an Office part, for our own XML reader (detachment of
 *  fast-xml-parser, `d2c-propositions/xml/plan.md`, tranche 5): qualified
 *  names, and attributes that would collide after the product's prefix
 *  rewriting. Checks only: the tree keeps every name as written, as
 *  fast-xml-parser does with the product's options.
 *  NOT here: the rewriting itself (`ooxml/xml.ts#canonicalize`, our own
 *  code, unchanged by the detachment; only its `renamed` is shared); the prefixes named inside attribute VALUES (`mc:Ignorable`,
 *  `mc:Choice Requires`: ECMA-376 Part 3, read by `canonicalize`); storage
 *  XHTML (its `ac:`/`ri:` prefixes are never declared: `tree.ts` runs this
 *  in document mode only).
 *  Called by: `tree.ts`. */

import { renamed } from "../ooxml/prefixes";
import { xmlRefusal } from "./tokenizer";

/**
 * Two checks, each of an Office part that would otherwise be read WRONG, never merely unusual (product owner, 25/10/2026:
 * refuse only what would publish wrong; read the rest exactly as fast-xml-parser reads it):
 * - W3C Namespaces in XML 1.0 (Third Edition) §4 QName = Prefix ':' LocalPart, both NCNames: at most one colon, neither
 *   side empty, the part after the colon starting with a NameStartChar (`p:1a` is a valid XML 1.0 Name, not a QName). A
 *   namespace declaration's prefix is an NCName too (§3 [3] PrefixedAttName). The product's readers never recognise
 *   such a name, so its content would vanish in silence. The tokenizer has already checked the Name.
 * - §6.3 NSC Attributes Unique, matched on the PRODUCT's mapping: `ooxml/xml.ts#canonicalize` rewrites prefixes
 *   by namespace URI (Transitional and Strict vocabularies to one prefix, spreadsheetml to none) and builds the
 *   attributes with `Object.fromEntries`, so two attributes of one element with the same canonical name lose a value.
 *   The check calls the same `renamed`. A prefix bound nowhere stays as written there, so it is read, not refused.
 * NOT checked, because the product reads those parts correctly and so does fast-xml-parser: an undeclared prefix,
 * the reserved prefixes and names (§3), an empty name for a prefix (§5), §7 (no colon in a PI target).
 * Each refusal is of WELL-FORMED XML 1.0, which fast-xml-parser reads: ours alone, outside the shadow's list of what no
 * valid part can hold.
 *
 * WORK: one binding costs O(1). Each prefix has a stack of names, pushed by a declaration and popped when its element
 * closes; no scope is ever copied (as `canonicalize` does), so deep nesting under many declarations stays linear.
 * Memory: one stack entry and at most one map key per declaration IN FORCE (a prefix leaves the map when its last
 * binding closes), so at most MAX_XML_DEPTH + 1 open elements × MAX_XML_ATTRIBUTES declarations.
 */

const XMLNS = "xmlns";

/** §2.3 NameChar that are not NameStartChar: `-`, `.`, digits, U+00B7, U+0300-036F, U+203F-2040. A LocalPart may
 *  not start with one; the tokenizer has already checked the rest of the Name. */
const startsAsNcName = (part: string): boolean => {
  const c = part.charCodeAt(0);
  if (c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39) || c === 0xb7) return false;
  return !((c >= 0x300 && c <= 0x36f) || c === 0x203f || c === 0x2040);
};

/** Splits a QName into prefix and local part; refuses what is not one. */
const split = (name: string): readonly [string | undefined, string] => {
  const colon = name.indexOf(":");
  if (colon < 0) return [undefined, name];
  if (colon === 0 || colon === name.length - 1 || name.includes(":", colon + 1)) throw xmlRefusal("malformed qualified name");
  const local = name.slice(colon + 1);
  if (!startsAsNcName(local)) throw xmlRefusal("malformed qualified name");
  return [name.slice(0, colon), local];
};

/** The prefix an attribute declares (`""` for the default namespace), or `undefined` when it declares none. */
const declaredPrefix = (prefix: string | undefined, local: string): string | undefined => {
  if (prefix === XMLNS) return local;
  return prefix === undefined && local === XMLNS ? "" : undefined;
};

/** The namespace scopes of one document, element by element, as the tree opens and closes them. */
export class NamespaceChecker {
  private readonly bindings = new Map<string, string[]>();
  /** Per open element, the prefixes it declared (to pop on close); `undefined` when none. */
  private readonly declaredBy: (string[] | undefined)[] = [];

  /** The scope in force, as `renamed` reads it. */
  private readonly scope = { get: (prefix: string): string | undefined => this.bindings.get(prefix)?.at(-1) };

  /** Checks an element's name and attributes against its own declarations and those in force. */
  open(name: string, attributes: readonly (readonly [string, string])[], selfClosing: boolean): void {
    // A refusal ends the reading of the part: the checker is dropped with the tree, never used again.
    const declared = this.declare(attributes);
    split(name);
    this.checkAttributes(attributes);
    if (selfClosing) this.undeclare(declared);
    else this.declaredBy.push(declared);
  }

  close(): void {
    this.undeclare(this.declaredBy.pop());
  }

  /** Binds the element's own declarations first: they apply to its own attributes. */
  private declare(attributes: readonly (readonly [string, string])[]): string[] | undefined {
    let declared: string[] | undefined;
    for (const [attribute, value] of attributes) {
      const [prefix, local] = split(attribute);
      const declares = declaredPrefix(prefix, local);
      if (declares === undefined) continue;
      const stack = this.bindings.get(declares);
      if (stack) stack.push(value);
      else this.bindings.set(declares, [value]);
      declared ??= [];
      declared.push(declares);
    }
    return declared;
  }

  /** §6.3: no two attributes of the element with the same canonical name (the product would keep one value). */
  private checkAttributes(attributes: readonly (readonly [string, string])[]): void {
    if (attributes.length < 2) return;
    const seen = new Set<string>();
    for (const [attribute] of attributes) {
      const canonical = renamed(attribute, this.scope, true);
      if (seen.has(canonical)) throw xmlRefusal("attributes repeated under their namespace");
      seen.add(canonical);
    }
  }

  /** Pops each binding; a prefix bound nowhere any more leaves the map, so what is kept is what is in force. */
  private undeclare(prefixes: readonly string[] | undefined): void {
    for (const prefix of prefixes ?? []) {
      const stack = this.bindings.get(prefix)!;
      stack.pop();
      if (stack.length === 0) this.bindings.delete(prefix);
    }
  }
}
