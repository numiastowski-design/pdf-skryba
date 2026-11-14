/** The words of a diagram in a sensible order — the order only, never a
 *  character (milestone 1 of the diagram text). A pure
 *  permutation: from the shapes of a drawing (their ids, boxes, order today)
 *  and its connectors (declared glue, line ends, arrow heads), it says which
 *  elements follow which, one paragraph per chain of relations, and which
 *  stay where they are. `paragraphs` flattened then `rest` is a permutation of
 *  the element indices (the property test says it): the ORDER creates, cuts
 *  and repeats nothing. Since 02/10/2026 (Mikolaj) the result also carries
 *  `links`, the arrows of the components that are not trees, as indices:
 *  what the caller publishes from them (names only) is its own business, and
 *  the order stays a permutation. Why: the layered landscapes of real decks
 *  (High_level_IT_Landscape: hubs with three arrows) are never trees, so
 *  the order kept today's reading order and the arrows, the one thing the
 *  file declares, were published nowhere. A component that is no tree but
 *  has NO cycle (arrow heads only) is read in topological order, every
 *  source before its target, ties in reading order: where a hub's sources
 *  come in relation to each other is arbitrary, and that no longer
 *  misleads since the relations are written out next to it. A component
 *  WITH a cycle has no such order: today's order stays (abstention
 *  `has-cycle`).
 *  Units are the caller's (EMU for OOXML); boxes are axis-aligned.
 *
 *  What counts as a relation, and the biases (written, chosen):
 *   - A connector's end is the shape it declares (`from`/`to`: `a:stCxn` /
 *     `a:endCxn`, ECMA-376 §20.1.2.2.8 `CT_Connection`, an `id`), or, when it
 *     declares none, the ONE shape whose outline lies within `endTouch` of
 *     the line's end. A shape whose box holds another touched shape is
 *     dropped (a frame behind its content: innermost). Two touched shapes,
 *     none, a point deep inside a box: abstain. A declared id the slide does
 *     not hold, or two readings that disagree: abstain.
 *   - Direction (Mikolaj, 02/10/2026): an arrow head at the line's end only,
 *     start to end; at its start only, end to start; both, start to end (the
 *     order of `a:stCxn` then `a:endCxn`, the line's own start and end). A
 *     connector with NO head is a plain association line: its
 *     `stCxn` to `endCxn` order is arbitrary (36 of 64 text-to-text
 *     connectors of High_level_IT_Landscape), so it says no direction and
 *     makes no relation (abstention `no-arrowhead`). Its ends are still
 *     ends: never taken for labels.
 *   - A connector with no visible line says nothing.
 *   - A label is never linked by the file (a connector has no text): a text
 *     element that is no end of any relation belongs to the connector whose
 *     midpoint is nearest, only when that one is within `labelReach` of the
 *     label's box AND every other connector is `ambiguity` times farther. A box that holds another shape (a frame) or
 *     a shape the caller flags `notLabel` is never a label. Otherwise it
 *     stays unrelated.
 *   - A component of related shapes is reordered only when it is a tree (one
 *     root, every shape with at most one incoming relation, no cycle, no
 *     double connector); a merge without cycle is read topologically (see
 *     above), a cycle keeps today's order for its shapes: an order we are
 *     not sure of is worse than the one we have. The arrows of both are
 *     given in `links`, one per target with every source (a double
 *     connector once, a loop never), targets and sources in today's order.
 *   - Paragraphs: a chain of relations is one paragraph; the first child
 *     continues its parent's paragraph, every further child opens a new one.
 *     Each shape is emitted once. Components follow the reading order of
 *     their first shape; whatever is not placed follows, in today's order.
 *  NOT here: what an element's text is, the separator, nor the IR
 *  (`extractor/pptx.ts`, `renderer/storage.ts`).
 *  Called by: `extractor/pptx.ts`, `extractor/docx-reader/body.ts`. */

import { distanceToPoint, fromBox, outlineDistance, type Rect } from "doc-ir/layout/rect";
import { holdsRect, RECT_RULES, rawFromBox } from "doc-ir/layout/rect-rules";
import type { Box } from "./slide-elements";

/** One element of the drawing, in TODAY's order (its index is its rank).
 *  `node`: a single text that may be an end of a relation or a label (a text
 *  shape with a box); a table, a picture, a SmartArt is not one.
 *  `notLabel`: the caller says it can be an end of a relation but never a
 *  label — a shape rotated or in a rotated or mirrored group (its box is the
 *  box of what is SEEN, not an edge a line can be measured against), a block
 *  arrow (its text is its own, not a line's). */
export interface DiagramElement {
  id?: string;
  box?: Box;
  node: boolean;
  notLabel?: boolean;
}

/** A shape with no text to publish: it can only be touched by a line end. */
export interface DiagramObstacle {
  id?: string;
  box?: Box;
}

export interface DiagramConnector {
  /** `a:stCxn id`, `a:endCxn id`. */
  from?: string;
  to?: string;
  /** The line's start and end, flips and groups applied. */
  ends?: { x1: number; y1: number; x2: number; y2: number };
  /** An arrow head at the line's start (`a:headEnd`) / end (`a:tailEnd`). */
  startArrow: boolean;
  endArrow: boolean;
  visible: boolean;
}

/** Starting values to calibrate (measured on 01/10/2026 over 374 pptx connectors and the Word
 *  diagrams; no label has a declared truth, only Mikolaj's eye judges it). */
export interface DiagramTolerances {
  /** Largest distance between a line's end and a shape's outline. */
  endTouch: number;
  /** Largest distance between a label's box and its connector's midpoint.
   *  Absolute, not scaled by the box: a big box (a node with no glued line,
   *  77 mm wide) must not reach far. */
  labelReach: number;
  /** How many times farther every other connector must be. */
  ambiguity: number;
}

type Abstention =
  | "invisible"
  | "no-ends"
  | "declared-unknown"
  | "declared-and-geometry-disagree"
  | "end-touches-nothing"
  | "end-touches-several"
  | "end-on-shape-without-text"
  | "no-arrowhead"
  | "loop"
  | "has-cycle"
  | "label-is-a-frame"
  | "label-too-far"
  | "label-ambiguous"
  | "label-on-unplaced-connector";

export interface DiagramOrder {
  /** Element indices, one list per paragraph. */
  paragraphs: number[][];
  /** Every other element index, in today's order. */
  rest: number[];
  /** `resolved`: connectors whose two ends are text elements; `total`: those kept (their component is a tree), by how their ends were found. */
  relations: { total: number; declared: number; geometry: number; mixed: number; resolved: number };
  /** The arrows of every component that is NOT a tree, one per target, sources without repeat (element indices, ascending). */
  links: { target: number; sources: number[] }[];
  /** The relations kept, with the labels attached to each (element indices). */
  edges: { source: number; target: number; labels: number[] }[];
  /** How many labels were attached to a relation. */
  labelsAttached: number;
  abstentions: Partial<Record<Abstention, number>>;
}

/** EMU per millimetre (914 400 per inch, 25.4 mm). */
const EMU_PER_MM = 36_000;

/** The tolerances for OOXML boxes (EMU): starting values to calibrate
 *  — `endTouch`: 4 mm, the value measured earlier against every declared glue
 *  it could be compared with (98 of 98 agreed). `labelReach`: 11 mm, the
 *  distance the earlier measure took (a text box within 11 mm of a line's
 *  midpoint); `ambiguity` 1.5: a connector's label must sit 1.5 times
 *  closer than any other connector's, else none is attached (a wrong label
 *  gives a wrong order, worse than today's). */
export const OOXML_DIAGRAM_TOLERANCES: DiagramTolerances = { endTouch: 4 * EMU_PER_MM, labelReach: 11 * EMU_PER_MM, ambiguity: 1.5 };

export interface DiagramInput {
  elements: readonly DiagramElement[];
  obstacles: readonly DiagramObstacle[];
  connectors: readonly DiagramConnector[];
  tolerances: DiagramTolerances;
}

/** A shape the drawing holds: an element (by index) or an obstacle (-1). */
interface Shape {
  id?: string;
  box?: Box;
  /** `box` as a normalised rectangle (for distances), built once per shape. */
  rect?: Rect;
  /** `box` with its coordinates as given (for the frame rule), built once per shape. */
  raw?: Rect;
  element: number;
}

type EndReading = { ok: true; shape: Shape; via: "declared" | "geometry" } | { ok: false; why: Abstention };

/** The nodes of a component with every source before its target, the ready ones (no unplaced source left) taken in reading order (lowest
 *  index first); `undefined` when a cycle leaves some unplaced. A binary min-heap: a diagram of thousands of shapes stays cheap. */
const topologicalOrder = (nodes: readonly number[], edges: readonly { source: number; target: number }[]): number[] | undefined => {
  const waiting = new Map<number, number>(nodes.map((n) => [n, 0]));
  const next = new Map<number, number[]>();
  for (const e of edges) {
    waiting.set(e.target, (waiting.get(e.target) ?? 0) + 1);
    const same = next.get(e.source);
    if (same === undefined) next.set(e.source, [e.target]);
    else same.push(e.target);
  }
  const heap: number[] = [];
  const push = (v: number): void => {
    heap.push(v);
    for (let i = heap.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (heap[up]! <= heap[i]!) break;
      [heap[up], heap[i]] = [heap[i]!, heap[up]!];
      i = up;
    }
  };
  const pop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]! < heap[m]!) m = l;
        if (r < heap.length && heap[r]! < heap[m]!) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  for (const [n, w] of waiting) if (w === 0) push(n);
  const out: number[] = [];
  while (heap.length > 0) {
    const n = pop();
    out.push(n);
    for (const t of next.get(n) ?? []) {
      const w = waiting.get(t)! - 1;
      waiting.set(t, w);
      if (w === 0) push(t);
    }
  }
  return out.length === nodes.length ? out : undefined;
};

/** One connector read into a relation: which elements, which way, and how its ends were found. */
interface Edge {
  connector: number;
  source: number;
  target: number;
  via: "declared" | "geometry" | "mixed";
}

type Abstain = (why: Abstention) => void;

/** The shapes of the drawing, and the same shapes by declared id. */
interface ShapeIndex {
  shapes: Shape[];
  byId: Map<string, Shape[]>;
}

/** Elements first (their index is their `element`), then obstacles (-1); ids may repeat, so `byId` keeps lists. */
const indexShapes = (elements: readonly DiagramElement[], obstacles: readonly DiagramObstacle[]): ShapeIndex => {
  const shapes: Shape[] = [
    ...elements.map((e, i): Shape => ({ ...(e.id === undefined ? {} : { id: e.id }), ...(e.box === undefined ? {} : { box: e.box, rect: fromBox(e.box), raw: rawFromBox(e.box) }), element: i })),
    ...obstacles.map((o): Shape => ({ ...(o.id === undefined ? {} : { id: o.id }), ...(o.box === undefined ? {} : { box: o.box, rect: fromBox(o.box), raw: rawFromBox(o.box) }), element: -1 })),
  ];
  const byId = new Map<string, Shape[]>();
  for (const s of shapes) {
    if (s.id === undefined) continue;
    const same = byId.get(s.id);
    if (same === undefined) byId.set(s.id, [s]);
    else same.push(s);
  }
  return { shapes, byId };
};

/** The reader of one end of a connector: the declared shape, else the ONE innermost shape the line's end touches. */
const makeEndReader = ({ shapes, byId }: ShapeIndex, tolerances: DiagramTolerances) => {
  /** Every shape whose outline the point touches, and among them the innermost ones. */
  const geometryReading = (x: number, y: number): { touched: Shape[]; innermost: Shape[] } => {
    const touched = shapes.filter((s) => s.rect !== undefined && outlineDistance(s.rect, x, y) <= tolerances.endTouch);
    const innermost = touched.filter((s) => !touched.some((o) => o !== s && s.raw !== undefined && o.raw !== undefined && holdsRect(RECT_RULES["diagram-frame"], s.raw, o.raw)));
    return { touched, innermost };
  };

  /** The shape an end declares: it must be known and unique, and a line end that touches shapes must touch it. */
  const readDeclared = (declaredId: string, touched: readonly Shape[]): EndReading => {
    const found = byId.get(declaredId);
    if (found === undefined || found.length !== 1) return { ok: false, why: "declared-unknown" };
    const shape = found[0]!;
    // The declared shape may be the frame around the one a line end also touches: still touched.
    if (touched.length > 0 && !touched.includes(shape)) return { ok: false, why: "declared-and-geometry-disagree" };
    return { ok: true, shape, via: "declared" };
  };

  return (declaredId: string | undefined, at: { x: number; y: number } | undefined): EndReading => {
    const { touched, innermost } = at === undefined ? { touched: [], innermost: [] } : geometryReading(at.x, at.y);
    if (declaredId !== undefined) return readDeclared(declaredId, touched);
    if (at === undefined) return { ok: false, why: "no-ends" };
    if (innermost.length === 0) return { ok: false, why: "end-touches-nothing" };
    if (innermost.length > 1) return { ok: false, why: "end-touches-several" };
    return { ok: true, shape: innermost[0]!, via: "geometry" };
  };
};

/** The two text elements a visible connector joins, with how its ends were found; `undefined` (and the abstention counted) when it joins no two. */
const readConnectorEnds = (
  c: DiagramConnector,
  elements: readonly DiagramElement[],
  readEnd: ReturnType<typeof makeEndReader>,
  abstain: Abstain,
): { a: number; b: number; via: Edge["via"] } | undefined => {
  if (!c.visible) return void abstain("invisible");
  const start = readEnd(c.from, c.ends && { x: c.ends.x1, y: c.ends.y1 });
  const end = readEnd(c.to, c.ends && { x: c.ends.x2, y: c.ends.y2 });
  if (!start.ok) return void abstain(start.why);
  if (!end.ok) return void abstain(end.why);
  const a = start.shape.element;
  const b = end.shape.element;
  if (a < 0 || b < 0 || !elements[a]!.node || !elements[b]!.node) return void abstain("end-on-shape-without-text");
  if (a === b) return void abstain("loop");
  return { a, b, via: start.via === end.via ? start.via : "mixed" };
};

/** Each connector with two readable text ends and a direction becomes an edge; the others are counted as abstentions, in the connectors' order. */
const resolveEdges = (
  input: DiagramInput,
  index: ShapeIndex,
  abstain: Abstain,
): { edges: Edge[]; plainEnds: Set<number> } => {
  const { elements, connectors, tolerances } = input;
  const readEnd = makeEndReader(index, tolerances);
  const edges: Edge[] = [];
  /** The ends of the plain lines: not related, but still ends, never labels. */
  const plainEnds = new Set<number>();
  connectors.forEach((c, i) => {
    const ends = readConnectorEnds(c, elements, readEnd, abstain);
    if (ends === undefined) return;
    const { a, b, via } = ends;
    if (!c.startArrow && !c.endArrow) {
      plainEnds.add(a);
      plainEnds.add(b);
      return abstain("no-arrowhead");
    }
    const reversed = c.startArrow && !c.endArrow;
    edges.push({ connector: i, source: reversed ? b : a, target: reversed ? a : b, via });
  });
  return { edges, plainEnds };
};

/** The weak components over the elements the relations touch. */
interface Components {
  componentOf: (i: number) => number;
  /** Elements of each component (ascending), components in the order of their lowest element. */
  members: Map<number, number[]>;
  edgesOf: Map<number, Edge[]>;
}

const splitComponents = (edges: readonly Edge[]): Components => {
  const parent = new Map<number, number>();
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Full path compression: a long chain must not cost a walk per lookup.
    for (let at = i; at !== root; ) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  for (const e of edges) {
    for (const i of [e.source, e.target]) if (!parent.has(i)) parent.set(i, i);
    const ra = find(e.source);
    const rb = find(e.target);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
  const componentOf = (i: number): number => find(i);
  const members = new Map<number, number[]>();
  for (const i of [...parent.keys()].sort((a, b) => a - b)) {
    const root = componentOf(i);
    const same = members.get(root);
    if (same === undefined) members.set(root, [i]);
    else same.push(i);
  }
  // Edges by component, once: a filter per component was quadratic.
  const edgesOf = new Map<number, Edge[]>();
  for (const e of edges) {
    const root = componentOf(e.source);
    const same = edgesOf.get(root);
    if (same === undefined) edgesOf.set(root, [e]);
    else same.push(e);
  }
  return { componentOf, members, edgesOf };
};

/** What each component is read as: a tree (`kept`), a DAG that is no tree (`topological`), or a cycle (neither); and the arrows of the non-trees. */
interface Classes {
  kept: Set<number>;
  topological: Map<number, number[]>;
  links: DiagramOrder["links"];
}

// A tree (n-1 connectors, at most one incoming relation each) is walked in pre-order; any other component WITHOUT a cycle is read in
// topological order; one with a cycle keeps today's order. All of them give their arrows as links.
const classifyComponents = ({ members, edgesOf }: Components, abstain: Abstain): Classes => {
  const kept = new Set<number>();
  const topological = new Map<number, number[]>();
  const links: DiagramOrder["links"] = [];
  const sourcesOf = new Map<number, Set<number>>();
  for (const [root, nodes] of members) {
    const mine = edgesOf.get(root) ?? [];
    const incoming = new Map<number, number>();
    for (const e of mine) incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    const tree = mine.length === nodes.length - 1 && [...incoming.values()].every((n) => n === 1);
    if (tree) kept.add(root);
    else {
      const order = topologicalOrder(nodes, mine);
      if (order === undefined) abstain("has-cycle");
      else topological.set(root, order);
      for (const e of mine) sourcesOf.set(e.target, (sourcesOf.get(e.target) ?? new Set<number>()).add(e.source));
    }
  }
  for (const target of [...sourcesOf.keys()].sort((a, b) => a - b)) links.push({ target, sources: [...sourcesOf.get(target)!].sort((a, b) => a - b) });
  return { kept, topological, links };
};

/** Labels: text elements that end no relation, attached to a kept relation's connector (by connector index). */
const attachLabels = (
  input: DiagramInput,
  shapes: readonly Shape[],
  keptEdges: readonly Edge[],
  endsOfRelation: ReadonlySet<number>,
  abstain: Abstain,
): { labelsOf: Map<number, number[]>; labelsAttached: number } => {
  const { elements, connectors, tolerances } = input;
  const midpoints = connectors.flatMap((c, index) => (c.visible && c.ends ? [{ index, x: (c.ends.x1 + c.ends.x2) / 2, y: (c.ends.y1 + c.ends.y2) / 2 }] : []));
  const labelsOf = new Map<number, number[]>();
  let labelsAttached = 0;
  elements.forEach((el, i) => {
    if (!el.node || el.notLabel === true || el.box === undefined || endsOfRelation.has(i) || keptEdges.length === 0) return;
    // A box that holds another shape is a frame with a title, not a label.
    const elShape = shapes[i]!;
    const elRect = elShape.rect!;
    if (shapes.some((s) => s.element !== i && s.raw !== undefined && holdsRect(RECT_RULES["diagram-frame"], elShape.raw!, s.raw))) return abstain("label-is-a-frame");
    const ranked = midpoints.map((m) => ({ index: m.index, d: distanceToPoint(elRect, m.x, m.y) })).sort((a, b) => a.d - b.d);
    const nearest = ranked[0];
    if (nearest === undefined) return;
    if (nearest.d > tolerances.labelReach) return abstain("label-too-far");
    const second = ranked[1];
    if (second !== undefined && !(second.d > nearest.d && second.d >= tolerances.ambiguity * nearest.d)) return abstain("label-ambiguous");
    if (!keptEdges.some((e) => e.connector === nearest.index)) return abstain("label-on-unplaced-connector");
    labelsOf.set(nearest.index, [...(labelsOf.get(nearest.index) ?? []), i]);
    labelsAttached++;
  });
  return { labelsOf, labelsAttached };
};

/** One frame of the iterative pre-order walk: a node's outgoing relations, the next one to take, and the paragraph being written. */
interface Frame {
  outs: readonly Edge[];
  k: number;
  current: number[];
}

/** The paragraphs of one tree: a pre-order walk from its top; the first child continues its parent's paragraph, every further one opens a new
 *  one; a relation's labels go before its target. Pushes onto `paragraphs` and marks `emitted`. */
const walkTree = (
  top: number,
  outgoing: ReadonlyMap<number, readonly Edge[]>,
  labelsOf: ReadonlyMap<number, readonly number[]>,
  paragraphs: number[][],
  emitted: Set<number>,
): void => {
  // Iterative pre-order walk (an explicit stack): a chain of thousands of
  // shapes overflowed the call stack of the recursive form.
  const stack: Frame[] = [];
  const enter = (at: number, current: number[]): void => {
    current.push(at);
    emitted.add(at);
    stack.push({ outs: outgoing.get(at) ?? [], k: 0, current });
  };
  const first: number[] = [];
  paragraphs.push(first);
  enter(top, first);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.k >= frame.outs.length) {
      stack.pop();
      continue;
    }
    const e = frame.outs[frame.k]!;
    const labels = labelsOf.get(e.connector) ?? [];
    for (const l of labels) emitted.add(l);
    if (frame.k === 0) {
      for (const l of labels) frame.current.push(l);
      frame.k++;
      enter(e.target, frame.current);
    } else {
      const next: number[] = [...labels];
      paragraphs.push(next);
      frame.k++;
      enter(e.target, next);
    }
  }
};

// Emission: components in reading order of their first element, a topological order or a pre-order walk of each tree.
const emitParagraphs = (
  { componentOf, members, edgesOf }: Components,
  { kept, topological }: Classes,
  outgoing: ReadonlyMap<number, readonly Edge[]>,
  labelsOf: ReadonlyMap<number, readonly number[]>,
): { paragraphs: number[][]; emitted: Set<number> } => {
  const paragraphs: number[][] = [];
  const emitted = new Set<number>();
  const roots = [...kept, ...topological.keys()].map((c) => members.get(c)!).sort((a, b) => a[0]! - b[0]!);
  for (const nodes of roots) {
    const order = topological.get(componentOf(nodes[0]!));
    if (order !== undefined) {
      paragraphs.push(order);
      for (const i of order) emitted.add(i);
      continue;
    }
    const into = new Set((edgesOf.get(componentOf(nodes[0]!)) ?? []).map((e) => e.target));
    walkTree(nodes.find((n) => !into.has(n))!, outgoing, labelsOf, paragraphs, emitted);
  }
  return { paragraphs, emitted };
};

export const orderDiagram = (input: DiagramInput): DiagramOrder => {
  const { elements, obstacles } = input;
  const abstentions: Partial<Record<Abstention, number>> = {};
  const abstain: Abstain = (why) => {
    abstentions[why] = (abstentions[why] ?? 0) + 1;
  };
  const index = indexShapes(elements, obstacles);
  const { edges, plainEnds } = resolveEdges(input, index, abstain);
  const components = splitComponents(edges);
  const classes = classifyComponents(components, abstain);
  const keptEdges = edges.filter((e) => classes.kept.has(components.componentOf(e.source)));
  // Outgoing relations by source, the lower target first (ties keep the connectors' order).
  const outgoing = new Map<number, Edge[]>();
  for (const e of keptEdges) {
    const same = outgoing.get(e.source);
    if (same === undefined) outgoing.set(e.source, [e]);
    else same.push(e);
  }
  for (const list of outgoing.values()) list.sort((a, b) => a.target - b.target);
  const endsOfRelation = new Set([...edges.flatMap((e) => [e.source, e.target]), ...plainEnds]);
  const { labelsOf, labelsAttached } = attachLabels(input, index.shapes, keptEdges, endsOfRelation, abstain);
  const { paragraphs, emitted } = emitParagraphs(components, classes, outgoing, labelsOf);
  const rest = elements.map((_, i) => i).filter((i) => !emitted.has(i));
  const count = (via: Edge["via"]): number => keptEdges.filter((e) => e.via === via).length;
  return {
    paragraphs,
    rest,
    links: classes.links,
    relations: { resolved: edges.length, total: keptEdges.length, declared: count("declared"), geometry: count("geometry"), mixed: count("mixed") },
    edges: keptEdges.map((e) => ({ source: e.source, target: e.target, labels: labelsOf.get(e.connector) ?? [] })),
    labelsAttached,
    abstentions,
  };
};
