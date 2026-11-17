/** The optional-content layers a viewer shows (ISO 32000-1:2008 §8.11.4), read from OUR dictionary: the default
 *  configuration `/OCProperties /D` (`/BaseState`, `/ON`, `/OFF`) and the usage `/View /ViewState` of each group.
 *  Decides: whether one optional-content group, or one membership dictionary (§8.11.2.2 policy or §8.11.2.2 expression),
 *  is shown in the display intent, as pdf.js's `getOptionalContentConfig().isVisible` said it was (measured before its removal).
 *  🔴 A group the configuration does not name is shown, and so is a page with no `/OCProperties` (pdf.js did the same).
 *  NOT here: the operand of a marked-content operator (`BDC /OC`), which `pdf-ops-ours.ts` resolves to a group object; the
 *  print intent (it is not rendered here); the radio-button groups (`/RBGroups`), which only matter to a user clicking.
 *  Measured against pdf.js (before its removal) on the fixtures and the corpus: `tools/poc/layers-shadow.ts` (deleted, see git history).
 *  Called by: `extractor/pdf-source.ts` (the layers of the hidden-text policy). */

import type { PdfObjectsDocument } from "./pdf-objects/document";
import { refKey, type PdfDict, type PdfValue } from "./pdf-objects/objects";

/** The group, as a `BDC /OC` operand carries it (the form pdf.js gave, kept by our reader): an OCG (`id`), or a membership dictionary (`ids`, a
 *  `policy`, or an `expression`). `undefined` when the operand could not be read: shown. */
export interface LayerGroup {
  readonly type?: string;
  readonly id?: string | null;
  readonly ids?: readonly string[] | null;
  readonly policy?: string | null;
  readonly expression?: readonly unknown[] | null;
}

/** The layers of one document: `isVisible` for a group operand, as `OptionalContentConfig.isVisible` has it. */
export interface LayerConfig {
  isVisible(group: unknown): boolean;
}

type VisibleOf = (key: string) => boolean | undefined;

/** The groups are the references of /OCGs; a direct dictionary has no key, so it is never named (pdf.js did the same). */
function namedGroupsOf(doc: PdfObjectsDocument, props: PdfDict): Map<string, PdfDict> {
  const groupKeys = new Map<string, PdfDict>();
  const ocgs = doc.resolve(props.get("OCGs"));
  if (ocgs?.kind !== "array") return groupKeys;
  for (const item of ocgs.items) {
    if (item.kind !== "ref") continue;
    const group = doc.dictOf(item);
    if (group !== undefined) groupKeys.set(refKey(item), group);
  }
  return groupKeys;
}

/** The keys, among the named groups, that an array of references lists. */
function namedKeysIn(
  doc: PdfObjectsDocument,
  groupKeys: ReadonlyMap<string, PdfDict>,
  value: PdfValue | undefined,
): string[] {
  const array = doc.resolve(value);
  if (array?.kind !== "array") return [];
  return array.items.flatMap((item) => (item.kind === "ref" && groupKeys.has(refKey(item)) ? [refKey(item)] : []));
}

/** §8.11.4.3: the default configuration starts from /BaseState (ON when absent), then /ON and /OFF switch groups. */
function initialStatesOf(
  doc: PdfObjectsDocument,
  props: PdfDict,
  groupKeys: ReadonlyMap<string, PdfDict>,
): Map<string, boolean> {
  const defaults = doc.dictOf(props.get("D"));
  const baseState = doc.resolve(defaults?.get("BaseState"));
  const initial = new Map<string, boolean>();
  for (const key of groupKeys.keys()) initial.set(key, baseState?.kind !== "name" || baseState.value !== "OFF");
  for (const key of namedKeysIn(doc, groupKeys, defaults?.get("ON"))) initial.set(key, true);
  for (const key of namedKeysIn(doc, groupKeys, defaults?.get("OFF"))) initial.set(key, false);
  return initial;
}

/** The groups the configuration names, by key, and whether each is visible in the display intent. */
export function layerConfigOf(doc: PdfObjectsDocument): LayerConfig {
  const catalog = doc.dictOf(doc.trailer().get("Root"));
  const props = doc.dictOf(catalog?.get("OCProperties"));
  if (props === undefined) return { isVisible: () => true };

  const groupKeys = namedGroupsOf(doc, props);
  const initial = initialStatesOf(doc, props, groupKeys);

  // The usage of the display intent: a group whose view state is OFF is hidden whatever the configuration says.
  const groupVisible = new Map<string, boolean>();
  for (const [key, group] of groupKeys) {
    const viewState = doc.resolve(doc.dictOf(doc.dictOf(group.get("Usage"))?.get("View"))?.get("ViewState"));
    const viewOff = viewState?.kind === "name" && viewState.value === "OFF";
    groupVisible.set(key, (initial.get(key) ?? true) && !viewOff);
  }

  const visibleOf: VisibleOf = (key) => groupVisible.get(key);
  return {
    isVisible: (group: unknown) => {
      if (groupVisible.size === 0 || group === null || group === undefined) return true;
      return visibilityOf(group, visibleOf);
    },
  };
}

/** §8.11.2.2 Table 98 policy applied to one member's state: `true`/`false` decides at once, `undefined` goes on. */
function policyVerdict(policy: string, state: boolean): boolean | undefined {
  if (policy === "AllOn" && !state) return false;
  if (policy === "AnyOn" && state) return true;
  if (policy === "AnyOff" && !state) return true;
  if (policy === "AllOff" && state) return false;
  return undefined;
}

/** An OCMD's `/OCGs` members, read in order, as pdf.js did: the first verdict that decides wins, and an unnamed member
 *  shows the group at once. */
function policyVisibility(group: LayerGroup, visibleOf: VisibleOf): boolean {
  // §8.11.2.2 Table 98: AnyOn when /P is absent.
  const policy = group.policy ?? "AnyOn";
  if (!["AnyOn", "AllOn", "AnyOff", "AllOff"].includes(policy)) return true;
  for (const id of group.ids ?? []) {
    const state = visibleOf(id);
    if (state === undefined) return true;
    const verdict = policyVerdict(policy, state);
    if (verdict !== undefined) return verdict;
  }
  return policy === "AllOn" || policy === "AllOff";
}

/** One membership dictionary: its expression first, then its single group, then its policy.
 *  ⚠️ LA BRANCHE DE L'EXPRESSION EST MORTE AUJOURD'HUI (revue du 03/11/2026, constat 5) : `pdf-ops-ours.ts` pose
 *  `expression: null` sans lire `/VE`, donc aucun OCMD n'arrive ici avec une expression. Elle est GARDÉE et non
 *  supprimée parce que l'évaluateur est juste, testé, et qu'il ne manque que la lecture — mais tant qu'elle n'est pas
 *  faite, un OCMD à `/VE` sans `/P` est jugé par la règle par défaut, qui peut rendre le verdict inverse. */
function membershipVisibility(group: LayerGroup, visibleOf: VisibleOf): boolean {
  if (group.expression !== undefined && group.expression !== null && group.expression.length > 0) {
    return evaluate(group.expression, visibleOf);
  }
  if (group.id !== undefined && group.id !== null) return visibleOf(group.id) ?? true;
  return policyVisibility(group, visibleOf);
}

/** One group operand, decided against the groups the configuration names. An unnamed group is shown. */
function visibilityOf(group: LayerGroup, visibleOf: VisibleOf): boolean {
  if (group.type === "OCG") {
    if (group.id === undefined || group.id === null) return true;
    return visibleOf(group.id) ?? true;
  }
  if (group.type !== "OCMD") return true;
  return membershipVisibility(group, visibleOf);
}

/** The state of one expression operand: a sub-expression, a group key, or `undefined` when it is neither or unnamed. */
function operandState(element: unknown, visibleOf: VisibleOf): boolean | undefined {
  if (Array.isArray(element)) return evaluate(element, visibleOf);
  if (typeof element === "string") return visibleOf(element);
  return undefined;
}

/** What one operand's state decides for the operator: `true`/`false` ends the evaluation, `undefined` goes on. */
function operatorVerdict(operator: unknown, state: boolean): boolean | undefined {
  if (operator === "And" && !state) return false;
  if (operator === "Or" && state) return true;
  if (operator === "Not") return !state;
  if (operator !== "And" && operator !== "Or") return true;
  return undefined;
}

/** A visibility expression (§8.11.2.2 Table 99): `[operator, operands...]`, nested arrays for sub-expressions. */
function evaluate(array: readonly unknown[], visibleOf: VisibleOf): boolean {
  if (array.length < 2) return true;
  const operator = array[0];
  for (let i = 1; i < array.length; i += 1) {
    const state = operandState(array[i], visibleOf);
    if (state === undefined) return true;
    const verdict = operatorVerdict(operator, state);
    if (verdict !== undefined) return verdict;
  }
  return operator === "And";
}
