/** `DocumentCache` (`document-cache.ts`): one bounded cache per document, shared by every kind of entry (performance review of 02/11/2026). */
import { describe, expect, it } from "vitest";

import { DocumentCache, documentCacheOf } from "./document-cache";

const A = Symbol("a");
const B = Symbol("b");
const length = (v: string): number => v.length;

describe("DocumentCache", () => {
  it("garde une valeur qui tient et ne la recalcule pas", () => {
    const cache = new DocumentCache(10);
    let calls = 0;
    const compute = (): string => ((calls += 1), "abcd");
    expect(cache.getOrCompute(A, "k", length, compute)).toBe("abcd");
    expect(cache.getOrCompute(A, "k", length, compute)).toBe("abcd");
    expect(calls).toBe(1);
  });

  it("la même clé dans deux genres est deux entrées", () => {
    const cache = new DocumentCache(10);
    expect(cache.getOrCompute(A, "k", length, () => "aaa")).toBe("aaa");
    expect(cache.getOrCompute(B, "k", length, () => "bbb")).toBe("bbb");
    expect(cache.getOrCompute(A, "k", length, () => "never")).toBe("aaa");
  });

  it("🔴 une valeur plus grosse que le plafond est rendue et jamais gardée", () => {
    const cache = new DocumentCache(10);
    let calls = 0;
    const big = (): string => ((calls += 1), "x".repeat(11));
    cache.getOrCompute(A, "big", length, big);
    cache.getOrCompute(A, "big", length, big);
    expect(calls).toBe(2);
    expect(cache.size).toBe(0);
  });

  it("🔴 fait de la place en retirant le moins récemment utilisé, QUEL QUE SOIT son genre : un genre ne prive pas l'autre", () => {
    const cache = new DocumentCache(10);
    cache.getOrCompute(A, "page1", length, () => "xxxxx"); // 5, kind A (a page already read, never asked for again)
    cache.getOrCompute(A, "page2", length, () => "xxxxx"); // 10
    let calls = 0;
    const logo = (): string => ((calls += 1), "yyyyy");
    cache.getOrCompute(B, "logo", length, logo); // kind B needs room: the oldest A entry goes, whatever the kind
    cache.getOrCompute(B, "logo", length, logo);
    expect(calls, "le logo (genre B) est gardé").toBe(1);
    expect(cache.size).toBeLessThanOrEqual(10);
  });

  it("une valeur souvent relue reste, quelle que soit son arrivée", () => {
    const cache = new DocumentCache(10);
    const calls: Record<string, number> = { a: 0, b: 0, c: 0 };
    const make =
      (key: string): (() => string) =>
      () => ((calls[key] = (calls[key] ?? 0) + 1), "xxxxx");
    cache.getOrCompute(A, "a", length, make("a"));
    cache.getOrCompute(A, "b", length, make("b"));
    cache.getOrCompute(A, "a", length, make("a")); // a used again: b is the oldest
    cache.getOrCompute(A, "c", length, make("c")); // room: b goes
    cache.getOrCompute(A, "a", length, make("a"));
    cache.getOrCompute(A, "c", length, make("c"));
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });
    cache.getOrCompute(A, "b", length, make("b"));
    expect(calls.b).toBe(2);
  });

  it("🔴 le total reste exact sous un appel réentrant sur la même clé", () => {
    const cache = new DocumentCache(10);
    cache.getOrCompute(A, "k", length, () => {
      cache.getOrCompute(A, "k", length, () => "xxxxx");
      return "yyyyy";
    });
    expect(cache.size, "5 et non 10").toBe(5);
  });

  it("undefined ne coûte rien et se garde", () => {
    const cache = new DocumentCache(0);
    let calls = 0;
    cache.getOrCompute<string | undefined>(
      A,
      "none",
      (v) => v?.length ?? 0,
      () => ((calls += 1), undefined),
    );
    cache.getOrCompute<string | undefined>(
      A,
      "none",
      (v) => v?.length ?? 0,
      () => ((calls += 1), undefined),
    );
    expect(calls).toBe(1);
  });

  it("le cache appartient au document : le même document rend le même cache, deux documents n'en partagent pas", () => {
    const one = {};
    const other = {};
    expect(documentCacheOf(one)).toBe(documentCacheOf(one));
    expect(documentCacheOf(other)).not.toBe(documentCacheOf(one));
  });
});

describe("DocumentCache : les entrées de coût nul ne sont pas évincées pour rien (dernier tour de revue de performance, 02/11/2026)", () => {
  it("🔴 une entrée qui ne coûte rien survit à la place faite pour une grosse, et ne se recalcule pas", () => {
    const cache = new DocumentCache(10);
    let zeroCalls = 0;
    const zero = (): string => ((zeroCalls += 1), "view");
    cache.getOrCompute(A, "zero", () => 0, zero); // costs nothing
    cache.getOrCompute(A, "old", length, () => "xxxxxx"); // 6
    cache.getOrCompute(A, "big", length, () => "yyyyyyyy"); // 8: needs the 6 of "old" out, not the zero entry
    cache.getOrCompute(A, "zero", () => 0, zero);
    expect(zeroCalls, "l'entrée de coût nul est restée").toBe(1);
    expect(cache.size).toBe(8);
  });
});

describe("DocumentCache : les entrées de coût nul ne ralentissent pas l'éviction (dernier tour, 02/11/2026)", () => {
  it("🔴 20 000 entrées de coût nul puis 20 000 insertions qui évincent : temps linéaire, pas 4 × 10⁸ pas", () => {
    const cache = new DocumentCache(10);
    for (let i = 0; i < 20_000; i += 1)
      cache.getOrCompute(
        A,
        `zero${i}`,
        () => 0,
        () => "view",
      );
    const started = performance.now();
    for (let i = 0; i < 20_000; i += 1)
      cache.getOrCompute(
        B,
        `real${i}`,
        () => 6,
        () => "xxxxxx",
      );
    expect(performance.now() - started).toBeLessThan(500);
    expect(cache.size).toBeLessThanOrEqual(10);
  });
});
