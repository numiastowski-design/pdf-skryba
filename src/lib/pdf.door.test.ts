/**
 * `detectLanguage`, through the published reading door (`pdf-skryba`): the one name of that door, beside the reader
 * itself, a third party calls. A PDF carries no declared language, so a client asks for it on the document the reader
 * hands back. The documents below are written by hand.
 * NOT here: the reader (`extractPdf`, held by the tests of `extractor/`), nor the rules of the detection, which the
 * base package holds with its own tests; this is the door's own answer on three plain cases.
 */
import { describe, expect, it } from "vitest";

import { detectLanguage } from "./pdf";
import type { IRDoc } from "./pdf-light";

const documentOf = (...paragraphs: string[]): IRDoc => ({
  blocks: paragraphs.map((text) => ({ kind: "paragraph", inlines: [{ text }] })),
});

const ENGLISH = [
  "The committee met on the first day of the month to review the work that had been done since the last report.",
  "It was agreed that the members of the team would have to send their notes to the office before the end of the week.",
  "There is no change in the way the requests are handled, and all of them will be answered in the order they were received.",
  "This document is one of the few that have been kept from that period, and it is not known who wrote it.",
];

const FRENCH = [
  "Le comité s'est réuni le premier jour du mois pour examiner le travail qui avait été fait depuis le dernier rapport.",
  "Il a été convenu que les membres de l'équipe devraient envoyer leurs notes au bureau avant la fin de la semaine.",
  "Il n'y a pas de changement dans la manière dont les demandes sont traitées, et elles seront toutes prises dans l'ordre.",
  "Ce document est l'un des rares qui aient été conservés de cette période, et on ne sait pas qui l'a écrit.",
];

describe("detectLanguage — the language of a document, read from its own text", () => {
  it("English prose is « en », French prose is « fr »", () => {
    expect(detectLanguage(documentOf(...ENGLISH))).toBe("en");
    expect(detectLanguage(documentOf(...FRENCH))).toBe("fr");
  });

  it("a text too short to decide gives no language, never a default one", () => {
    // Failure value: "en", a default handed out for a document the detection cannot read.
    expect(detectLanguage(documentOf("Invoice 2026-0042"))).toBeUndefined();
    expect(detectLanguage(documentOf())).toBeUndefined();
  });

  it("reads the document and writes nothing into it", () => {
    const document = documentOf(...ENGLISH);
    const before = JSON.stringify(document);
    detectLanguage(document);
    expect(JSON.stringify(document)).toBe(before);
  });
});
