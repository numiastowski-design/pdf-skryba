/**
 * A list marker induced from the document itself. `layout/list.ts#markerOf` knows a fixed list of markers, and a lone
 * letter is not one of them: items whose bullet is an "o" (Word's level-2 bullet, rendered as the letter) came out
 * as paragraphs.
 * The rule adds a marker only if the document uses it as one: the same token opens at least three lines, all at the
 * same indent. That is what tells the bullet "o" from the Italian word "o", which opens sentences at any indent.
 * Run: npx vitest run --project=main src/layout/induced-markers.test.ts
 */
import { describe, expect, it } from "vitest";

import { inducedMarkers, type MarkerLine } from "./induced-markers";

const line = (text: string, left: number): MarkerLine => ({ text, left });

describe("les marqueurs qu'un document se donne", () => {
  it("induit « o » quand il ouvre trois lignes au même retrait", () => {
    const lines = [
      line("o premier point de la liste", 108),
      line("o deuxième point de la liste", 108),
      line("o troisième point de la liste", 108),
      line("Un paragraphe ordinaire qui ne commence par rien.", 72),
    ];
    expect(inducedMarkers(lines)).toEqual(["o"]);
  });

  it("n'induit rien quand le jeton se promène — le « o » italien", () => {
    const lines = [
      line("o il tempo è bello", 72),
      line("o la pioggia cade", 150),
      line("o forse domani", 96),
      line("Un paragraphe ordinaire.", 72),
    ];
    expect(inducedMarkers(lines)).toEqual([]);
  });

  it("n'induit rien sous trois occurrences", () => {
    const lines = [line("o premier", 108), line("o deuxième", 108), line("Un paragraphe.", 72)];
    expect(inducedMarkers(lines)).toEqual([]);
  });

  it("induit plusieurs marqueurs quand chacun tient SON retrait", () => {
    const lines = [
      line("§ premier", 72),
      line("§ deuxième", 72),
      line("§ troisième", 72),
      line("o premier sous-point", 108),
      line("o deuxième sous-point", 108),
      line("o troisième sous-point", 108),
    ];
    expect(inducedMarkers(lines).sort()).toEqual(["o", "§"]);
  });

  it("n'induit pas un mot : un marqueur est court", () => {
    const lines = [line("Article premier", 72), line("Article deuxième", 72), line("Article troisième", 72)];
    expect(inducedMarkers(lines)).toEqual([]);
  });

  it("n'induit pas un jeton déjà reconnu par la liste fixe — « - » et « 1. » n'ont pas besoin d'elle", () => {
    const lines = [line("- premier", 108), line("- deuxième", 108), line("- troisième", 108)];
    expect(inducedMarkers(lines)).toEqual([]);
  });

  it("tolère le bruit de rendu sur le retrait, pas un écart réel", () => {
    const serrees = [line("o un", 108), line("o deux", 108.4), line("o trois", 107.7)];
    expect(inducedMarkers(serrees)).toEqual(["o"]);
    const eparses = [line("o un", 108), line("o deux", 130), line("o trois", 90)];
    expect(inducedMarkers(eparses)).toEqual([]);
  });

  it("rend les marqueurs dans un ordre stable, quel que soit l'ordre des lignes", () => {
    const lines = [
      line("o a", 108),
      line("§ b", 72),
      line("o c", 108),
      line("§ d", 72),
      line("o e", 108),
      line("§ f", 72),
    ];
    expect(inducedMarkers(lines)).toEqual(inducedMarkers([...lines].reverse()));
  });
});
