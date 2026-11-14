/** The language a document is written in, decided locally and deterministically
 *  — sampling windows of prose, scoring them against the profiles, and
 *  abstaining when the margin is too thin.
 *  NOT here: the per-language data (`pipeline/language-profiles.ts`), what
 *  « same language » means (`core/language.ts`), nor the decision to translate
 *  (`core/state-machine.ts#shouldTranslate`).
 *  Called by: `orchestrator/doc-processor.ts`. */

/**
 * detectLanguage — détection de langue LOCALE, déterministe, sans dépendance
 * npm et sans appel réseau (C6 lot 1, partie B, 08/09/2026).
 *
 * POURQUOI LOCALE PLUTÔT QU'UN APPEL AU MODÈLE
 * ============================================
 * La détection existe pour ÉVITER d'envoyer chez Gemini les documents déjà
 * rédigés dans la langue de référence. Payer un appel au modèle pour découvrir
 * qu'on n'a pas besoin d'appeler le modèle annulerait l'essentiel du gain : sur
 * le cas majoritaire — celui qu'on optimise — un appel de détection coûterait
 * l'équivalent d'un appel vision, par document, pour apprendre qu'il n'y a rien
 * à faire. Ici le coût est nul.
 *
 * `lib/ir.ts#IRDoc.lang` déclarait d'ailleurs déjà `IRDoc.lang` avec la mention
 * « BCP-47, detected programmatically (no AI) » — champ jamais écrit ni lu à ce
 * jour. L'intention était posée dès l'origine.
 *
 * L'IMPRÉCISION TOMBE DU BON CÔTÉ
 * ===============================
 * Texte trop court, tableur numérique, document bilingue équilibré, langue
 * absente de la table : dans tous ces cas la réponse est `undefined`, et
 * `undefined` signifie « ne pas traduire ». Cette heuristique s'abstient au
 * lieu de deviner ; elle ne peut donc pas provoquer la réécriture d'un
 * document qui n'en avait pas besoin. C'est le sens dans lequel on accepte de
 * se tromper — jamais l'autre.
 *
 * CE QUI NE DOIT JAMAIS ARRIVER : ÉCRIRE DANS L'IRDoc
 * ==================================================
 * Le résultat reste une VALEUR DE RETOUR. Rien n'est posé sur le document, ni
 * sur `IRDoc.lang` qui reste délibérément mort. `contentHash` est un
 * `hashIRDoc` du document extrait (`orchestrator/doc-processor.ts`, là où `contentHash` est calculé) : tout
 * champ ajouté à l'IRDoc est à un refactor près d'entrer dans ce hash, et ce
 * refactor-là ferait republier le corpus entier — le coût exact que documente
 * l'en-tête de `pipeline/content-hash.ts`.
 *
 * Pur : ni I/O, ni horloge, ni aléa (règle de déterminisme, eslint.config.js).
 */

import { diagramParagraphs, type IRBlock, type IRDoc } from "../lib/ir";
import { walkBlocks } from "../lib/ir-walk";
import { FUNCTION_WORD_SETS, SCRIPT_PROFILES } from "./language-profiles";

// ---------------------------------------------------------------------------
// Seuils — VALEURS DE DÉPART, à calibrer sur le corpus RÉEL, qui n'a pas encore
// été passé au travers (STATUS.md, C6 lot 1). `MIN_MARGIN_FACTOR` fait
// exception : il a été déplacé sur une mesure, détaillée à sa déclaration. Les
// trois autres restent des choix raisonnés, pas des observations.
//
// Les tests épinglent le COMPORTEMENT que ces seuils commandent (« sous le
// plancher ⇒ undefined »), jamais un taux de justesse — le corpus de test est
// écrit à la main, donc il ne peut pas en mesurer un.
// ---------------------------------------------------------------------------

/** Une fenêtre d'échantillonnage. Trois fenêtres ⇒ 2100 caractères, soit
 *  ≈ 300 mots : de quoi produire 30 à 60 occurrences de mots-outils pour une
 *  langue européenne, largement au-dessus du bruit. Au-delà le score ne bouge
 *  plus ; sous ~500 caractères au total, il oscille. */
const WINDOW_CHARS = 700;

/** Début, milieu, fin. Prendre seulement la tête serait un piège : une page de
 *  garde ou un en-tête anglais dans un document français fausserait tout. Trois
 *  fenêtres font gagner la langue dominante SUR L'ENSEMBLE du document. */
const WINDOW_COUNT = 3;

/** Sous ce volume de prose, on s'abstient : un document de douze mots ne vaut
 *  pas une hypothèse. */
export const MIN_SAMPLE_CHARS = 200;

/** Le même plancher, exprimé en tokens alphabétiques — c'est celui qui attrape
 *  le tableur : des lignes de chiffres produisent beaucoup de caractères et
 *  presque aucun mot. */
export const MIN_ALPHA_TOKENS = 40;

/** Le meilleur score doit représenter au moins cette part des tokens. En
 *  dessous, aucune langue ne « reconnaît » vraiment le texte — cas d'un jargon
 *  technique, d'une liste de noms propres, ou d'une langue absente de la table. */
const MIN_SCORE_RATIO = 0.15;

/**
 * Et il doit dépasser le deuxième d'au moins ce facteur. C'est cette règle, et
 * non la disjonction des jeux de mots, qui protège des langues proches.
 *
 * 1,5 est MESURÉ, pas choisi (08/09/2026, sur les dix-huit textes de
 * `detect-language.test.ts` — écrits à la main, donc indicatifs, pas un corpus
 * réel). La bonne langue arrive première dans 18 cas sur 18 ; ce sont les
 * MARGES qui s'étalent :
 *
 *     da 1,08   no 1,08   pt 1,57   sv 1,80   pl 2,00   it 2,10   ru 2,38
 *     es 2,45   fi 2,60   uk 2,67   cs 2,80   tr 3,00   fr 3,38   hu 3,80
 *     nl 3,86   ro 4,25   de 7,67   en 12,00
 *
 * et un document moitié français moitié anglais tombe à **1,33**.
 *
 * Il n'existe AUCUN écart net entre « document bilingue » et « deux langues
 * proches » : numériquement c'est le même phénomène — deux langues à score
 * voisin — et c'est très bien ainsi, puisque la bonne réponse est la même dans
 * les deux cas : s'abstenir. Le seuil ne fait que placer la limite. À 1,25
 * (première valeur proposée, avant mesure) le document 50/50 passait et se
 * faisait classer « anglais » ; à 1,5 il s'abstient, et seize des dix-huit
 * langues continuent de se trancher.
 *
 * Conséquence assumée : le portugais est à 1,57, donc À PEINE au-dessus. Un
 * texte portugais un peu plus hispanisant s'abstiendra. C'est le sens dans
 * lequel on veut se tromper.
 */
export const MIN_MARGIN_FACTOR = 1.5;

/** Part des lettres qu'une écriture doit représenter pour trancher à elle
 *  seule. 20 % laisse passer un document japonais truffé de termes latins,
 *  sans qu'une citation grecque dans un texte français ne suffise. */
const MIN_SCRIPT_RATIO = 0.2;

// ---------------------------------------------------------------------------
// Échantillonnage
// ---------------------------------------------------------------------------

/** Les cellules de `table` sont volontairement ABSENTES de ce parcours : elles
 *  sont courtes, souvent numériques, et gonfleraient le total de caractères
 *  sans apporter de mots-outils — c'est-à-dire qu'elles feraient franchir le
 *  plancher à un tableur qui n'a rien à dire sur sa langue. `equation.text`
 *  est écarté pour la même raison (notation, pas prose). */
function collectProse(blocks: readonly IRBlock[], out: string[]): void {
  walkBlocks(blocks, (block) => {
    switch (block.kind) {
      case "heading":
      case "paragraph":
        out.push(block.inlines.map((i) => i.text).join(""));
        break;
      // The sections' text only: a label is ours, not the document's prose.
      case "diagramText":
        // One entry per paragraph (`breaks`), never joined across a break:
        // the last word of a chain and the first of the next would glue.
        for (const section of block.sections) {
          for (const paragraph of diagramParagraphs(section)) out.push(paragraph.map((i) => i.text).join(""));
        }
        break;
      case "section":
        if (block.title !== undefined) out.push(block.title);
        break;
      case "chart":
        if (block.title !== undefined) out.push(block.title);
        out.push(...(block.axisTitles ?? []).map((t) => t.text));
        break;
      // Containers: `walkBlocks` enters them (a tab's label is ours, "Slide N": only its content is prose).
      case "list":
      case "footnote":
      case "columns":
      case "tabs":
      case "toc":
      case "image": // no text of its own (no image goes to vision)
        break;
      case "table":
      case "equation":
        // Deliberately not entered (see the comment above).
        return false;
      default: {
        // A new block kind must be decided here, never ignored silently.
        const unhandled: never = block;
        return unhandled;
      }
    }
  });
}

/** Le texte de prose du document, dans l'ordre, sans les tableaux. */
export function collectProseText(doc: IRDoc): string {
  const parts: string[] = [];
  collectProse(doc.blocks, parts);
  return parts.filter((p) => p.length > 0).join("\n");
}

/** Trois fenêtres — début, milieu, fin — ou le texte entier s'il est plus court
 *  que leur somme. Découpage strictement positionnel, donc déterministe. */
export function buildDetectionSample(doc: IRDoc): string {
  const text = collectProseText(doc);
  const total = WINDOW_CHARS * WINDOW_COUNT;
  if (text.length <= total) return text;
  const middleStart = Math.floor((text.length - WINDOW_CHARS) / 2);
  return [
    text.slice(0, WINDOW_CHARS),
    text.slice(middleStart, middleStart + WINDOW_CHARS),
    text.slice(text.length - WINDOW_CHARS),
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Coupe sur toute frontière non-alphabétique, apostrophes comprises : les
 *  chiffres et la ponctuation deviennent des séparateurs, donc aucun token
 *  numérique ne survit. `l'entreprise` donne `l` + `entreprise`, et ces formes
 *  élidées sont très discriminantes (cf. `language-profiles.ts`). */
export function tokenize(sample: string): string[] {
  return sample
    .toLowerCase()
    .split(/[^\p{L}\p{M}]+/u)
    .filter((t) => t.length > 0);
}

function detectByScript(sample: string): string | undefined {
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return undefined;
  for (const { lang, pattern } of SCRIPT_PROFILES) {
    // `matchAll` plutôt que `pattern.test` : un littéral `/g` porte un
    // `lastIndex` mutable, et `test` sur une regex partagée entre appels
    // renverrait un résultat dépendant de l'appel PRÉCÉDENT. Cette table est
    // au niveau module, donc partagée — le piège est réel, pas théorique.
    const count = [...sample.matchAll(pattern)].length;
    if (count / letters >= MIN_SCRIPT_RATIO) return lang;
  }
  return undefined;
}

/**
 * Le classement complet, exposé pour les tests et le diagnostic. Trié par score
 * décroissant, à égalité par code de langue pour rester stable — un `sort`
 * instable rendrait la fonction non déterministe sur des scores identiques.
 */
export function scoreLanguages(tokens: readonly string[]): { lang: string; score: number }[] {
  if (tokens.length === 0) return [];
  return FUNCTION_WORD_SETS.map(({ lang, words }) => {
    let hits = 0;
    for (const token of tokens) if (words.has(token)) hits += 1;
    return { lang, score: hits / tokens.length };
  }).sort((a, b) => (b.score !== a.score ? b.score - a.score : a.lang < b.lang ? -1 : 1));
}

/** Détection sur un échantillon déjà constitué. Séparée de `detectLanguage`
 *  pour que les tests puissent permuter les fenêtres et vérifier que la langue
 *  dominante ne dépend pas de leur ordre. */
export function detectLanguageFromSample(sample: string): string | undefined {
  const byScript = detectByScript(sample);
  if (byScript !== undefined) return byScript;

  if (sample.length < MIN_SAMPLE_CHARS) return undefined;

  const tokens = tokenize(sample);
  if (tokens.length < MIN_ALPHA_TOKENS) return undefined;

  const ranked = scoreLanguages(tokens);
  const best = ranked[0];
  if (!best || best.score < MIN_SCORE_RATIO) return undefined;

  const second = ranked[1];
  // Pas de deuxième langue dans la table ⇒ rien à départager, la marge est
  // acquise. Un second à zéro donne une marge infinie, ce qui est correct.
  if (second && second.score > 0 && best.score < second.score * MIN_MARGIN_FACTOR) return undefined;

  return best.lang;
}

/**
 * La langue dominante du document, en BCP-47, ou `undefined` si indéterminée.
 *
 * `undefined` n'est JAMAIS remplacé par une langue par défaut : l'appelant doit
 * traiter l'indétermination comme « ne pas traduire ». Une valeur par défaut
 * ici ferait traduire, à l'aveugle, tous les documents que l'heuristique
 * n'arrive pas à lire.
 */
export function detectLanguage(doc: IRDoc): string | undefined {
  return detectLanguageFromSample(buildDetectionSample(doc));
}
