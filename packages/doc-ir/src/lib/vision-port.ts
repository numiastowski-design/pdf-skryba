/** The contract for asking a model what an image says, DECLARED by the reading library and implemented by the app: one call per
 *  image, text extraction only — never a description. The library reads through it and never names a provider.
 *  NOT here: the model call (`vision/gemini.ts`), the fake (`vision/fake.ts`), nor the rule that drops an image with nothing
 *  readable (`extractor/pdf.ts`). `vision/port.ts` re-exports these three types, so the app keeps ONE definition, at this address.
 *  Called by: `extractor/dispatch.ts` and `extractor/pdf-scanned.ts` read through it; `vision/port.ts` hands it on to the app
 *  (`vision/{gemini,fake,index}.ts` implement it, `orchestrator/doc-processor.ts` and `tools/abstention-map.ts` use it). */

/**
 * vision — port for AI image analysis (MIKSUDOC « Spécification technique » §5.5). The port is the
 * socket; only the adapter changes if the underlying model provider ever
 * changes. One call per image, a single-task prompt (text extraction only —
 * no description: an image with nothing readable is excluded from the page
 * entirely rather than described, MIKSUDOC « Spécification fonctionnelle » §6.6/§9), never a
 * network/model detail leaking into callers.
 */

import type { TableData } from "./ir";

export interface BinaryRef {
  bytes: Uint8Array;
  mimeType: string;
}

export interface VisionResult {
  /** OCR'd text, "" when the image has none (a signature, logo, stamp, or a
   *  purely graphical diagram — the "mute" case, MIKSUDOC « Spécification fonctionnelle » §6.6/§9: the
   *  image is excluded from the page entirely, never described). */
  text: string;
  /** Self-reported 0..1 confidence — Gemini has no native score, this is
   *  required in the structured JSON output itself (§5.5). */
  confidence: number;
  /** One-sentence summary, used as alt text when `text` is long (§6.6). */
  altSummary?: string;
  /** Present when the image is itself a data table/chart-like graphic. */
  structuredTables?: TableData[];
}

/** 🔴 `analyzeImage` A ÉTÉ RETIRÉ DE CE PORT LE 17/09/2026 (décision de
 *  Mikolaj) : **aucune image de document ne part chez un tiers.** Ce n'est pas
 *  une option de configuration ni un interrupteur — la capacité n'existe plus,
 *  donc aucun appelant ne peut la retrouver par distraction.
 *
 *  Ce qui disparaît avec elle, écrit pour le prochain lecteur plutôt que perdu :
 *  le texte alternatif tiré de l'image, le bloc dépliant « Text extracted from
 *  image », et la SUPPRESSION de l'image quand le modèle n'y lisait rien. Ce
 *  dernier point est le plus visible : logos, tampons et signatures étaient
 *  retirés des pages, ils y sont maintenant publiés.
 *
 *  Reste `analyzeDocument`, et la distinction est délibérée : un PDF SCANNÉ n'a
 *  pas d'autre texte que celui de ses pixels. Sans lui, le document entier
 *  devient introuvable par la recherche — ce n'est plus une légende qu'on perd,
 *  c'est tout le contenu. */
export interface VisionPort {
  /** A batch of PDF pages (MIKSUDOC « Spécification technique » §5.4: "PDF scanné/mixte |
   *  pdf-lib : découpage en lots de pages → vision (Gemini) par lots") —
   *  `doc` is itself a small PDF (a page slice, built with pdf-lib), and the
   *  result has exactly one entry per page in that slice, in page order.
   *  Gemini reads PDFs natively; no page-to-image rasterization needed. */
  analyzeDocument(doc: BinaryRef, opts?: { languages?: string[] }): Promise<VisionResult[]>;
}
