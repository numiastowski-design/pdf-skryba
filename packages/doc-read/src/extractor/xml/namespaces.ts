/** Namespace checks of an Office part for our own XML reader: qualified names, and attributes that would collide after
 *  the product's prefix rewriting. Checks only: the tree keeps every name as written.
 *  Decides: which parts are refused, either as not namespace-well-formed or because two attributes would collide once
 *  their prefixes are rewritten.
 *  NOT here: the rewriting itself (`ooxml/xml.ts#canonicalize`; only its `renamed` is shared); the prefixes named
 *  inside attribute VALUES (`mc:Ignorable`, `mc:Choice Requires`: ECMA-376 Part 3, read by `canonicalize`); storage
 *  XHTML (its `ac:`/`ri:` prefixes are never declared: `tree.ts` runs this in document mode only).
 *  Called by: `tree.ts`. */

import { renamed } from "../ooxml/prefixes";
import { xmlRefusal } from "./tokenizer";

/**
 * Two checks, each of an Office part that would otherwise be read WRONG, never merely unusual (decision of the
 * maintainer, 25/10/2026: refuse only what would publish wrong; read the rest as written):
 * - W3C Namespaces in XML 1.0 (Third Edition) §4 QName = Prefix ':' LocalPart, both NCNames: at most one colon, neither
 *   side empty, the part after the colon starting with a NameStartChar (`p:1a` is a valid XML 1.0 Name, not a QName). A
 *   namespace declaration's prefix is an NCName too (§3 [3] PrefixedAttName). The product's readers never recognise
 *   such a name, so its content would vanish in silence. The tokenizer has already checked the Name.
 * - §6.3 NSC Attributes Unique, matched on the PRODUCT's mapping: `ooxml/xml.ts#canonicalize` rewrites prefixes
 *   by namespace URI (Transitional and Strict vocabularies to one prefix, spreadsheetml to none) and builds the
 *   attributes with `Object.fromEntries`, so two attributes of one element with the same canonical name lose a value.
 *   The check calls the same `renamed`. A prefix bound nowhere stays as written there, so it is read, not refused.
 * NOT checked, because the product reads those parts correctly: an undeclared prefix, the reserved prefixes and names
 * (§3), an empty name for a prefix (§5), §7 (no colon in a PI target).
 * Each refusal is of WELL-FORMED XML 1.0: ours alone, not a rule of the standard's well-formedness.
 *
 * WORK: one binding costs O(1). Each prefix has a stack of names, pushed by a declaration and popped when its element
 * closes; no scope is ever copied (as `canonicalize` does), so deep nesting under many declarations stays linear.
 * Memory: one stack entry and at most one map key per declaration IN FORCE (a prefix leaves the map when its last
 * binding closes), so at most MAX_XML_DEPTH + 1 open elements × MAX_XML_ATTRIBUTES declarations.
 */

const XMLNS = "xmlns";

/** Whether the first character of a Name the tokenizer has already checked is a NameStartChar: the NameChar of §2.3
 *  that are not NameStartChar (`-`, `.`, digits, U+00B7, U+0300-036F, U+203F-2040) are the only ones left to exclude.
 *  A LocalPart may not start with one. */
const isNameStartCharOfCheckedName = (part: string): boolean => {
  const firstCharCode = part.charCodeAt(0);
  if (
    firstCharCode === 0x2d ||
    firstCharCode === 0x2e ||
    (firstCharCode >= 0x30 && firstCharCode <= 0x39) ||
    firstCharCode === 0xb7
  )
    return false;
  return !((firstCharCode >= 0x300 && firstCharCode <= 0x36f) || firstCharCode === 0x203f || firstCharCode === 0x2040);
};

/** Splits a QName into prefix and local part; refuses what is not one. */
const splitQualifiedName = (name: string): readonly [string | undefined, string] => {
  const colon = name.indexOf(":");
  if (colon < 0) return [undefined, name];
  if (colon === 0 || colon === name.length - 1 || name.includes(":", colon + 1))
    throw xmlRefusal("malformed qualified name");
  const localName = name.slice(colon + 1);
  if (!isNameStartCharOfCheckedName(localName)) throw xmlRefusal("malformed qualified name");
  return [name.slice(0, colon), localName];
};

/** The prefix an attribute declares (`""` for the default namespace), or `undefined` when it declares none. */
const findDeclaredPrefix = (prefix: string | undefined, localName: string): string | undefined => {
  if (prefix === XMLNS) return localName;
  if (prefix === undefined && localName === XMLNS) return "";
  return undefined;
};

/** The namespace scopes of one document, element by element, as the tree opens and closes them. */
export class NamespaceChecker {
  private readonly bindings = new Map<string, string[]>();
  /** Per open element, the prefixes it declared (to pop on close); `undefined` when none. */
  private readonly declaredPrefixesByOpenElement: (string[] | undefined)[] = [];

  /** The scope in force, as `renamed` reads it. */
  private readonly scope = { get: (prefix: string): string | undefined => this.bindings.get(prefix)?.at(-1) };

  /** Checks an element's name and attributes against its own declarations and those in force. */
  open(name: string, attributes: readonly (readonly [string, string])[], isSelfClosing: boolean): void {
    // A refusal ends the reading of the part: the checker is dropped with the tree, never used again.
    const declaredPrefixes = this.declare(attributes);
    splitQualifiedName(name);
    this.checkAttributes(attributes);
    if (isSelfClosing) this.undeclare(declaredPrefixes);
    else this.declaredPrefixesByOpenElement.push(declaredPrefixes);
  }

  close(): void {
    this.undeclare(this.declaredPrefixesByOpenElement.pop());
  }

  /** Binds the element's own declarations first: they apply to its own attributes. */
  private declare(attributes: readonly (readonly [string, string])[]): string[] | undefined {
    let declaredPrefixes: string[] | undefined;
    for (const [attribute, value] of attributes) {
      const [prefix, localName] = splitQualifiedName(attribute);
      const declaredPrefix = findDeclaredPrefix(prefix, localName);
      if (declaredPrefix === undefined) continue;
      const bindingStack = this.bindings.get(declaredPrefix);
      if (bindingStack) bindingStack.push(value);
      else this.bindings.set(declaredPrefix, [value]);
      declaredPrefixes ??= [];
      declaredPrefixes.push(declaredPrefix);
    }
    return declaredPrefixes;
  }

  /** §6.3: no two attributes of the element with the same canonical name (the product would keep one value). */
  private checkAttributes(attributes: readonly (readonly [string, string])[]): void {
    if (attributes.length < 2) return;
    const seenCanonicalNames = new Set<string>();
    for (const [attribute] of attributes) {
      const canonicalName = renamed(attribute, this.scope, true);
      if (seenCanonicalNames.has(canonicalName)) throw xmlRefusal("attributes repeated under their namespace");
      seenCanonicalNames.add(canonicalName);
    }
  }

  /** Pops each binding; a prefix bound nowhere any more leaves the map, so what is kept is what is in force. */
  private undeclare(prefixes: readonly string[] | undefined): void {
    for (const prefix of prefixes ?? []) {
      const bindingStack = this.bindings.get(prefix)!;
      bindingStack.pop();
      if (bindingStack.length === 0) this.bindings.delete(prefix);
    }
  }
}
