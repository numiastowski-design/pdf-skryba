// Decides whether a source comment is written in French, for the quality ratchet (tools/quality/measure.ts), which
// counts one finding per French comment so that their number only goes down. It does not translate nor judge the
// English of a comment, and it is not a lint error: `eslint.config.js` does not load it.
import { Linter, type Rule } from "eslint";
import { parser } from "typescript-eslint";

/** French function words that are not common English words, matched as whole words, case ignored. None of the 21
 *  appears in the 502 single comments of `packages/docs-scribe/src/extractor/docx-reader/` (18/11/2026), and none was seen used
 *  as an English or technical word (`LE`, `DES`, `EST`) in the production code: no candidate was set aside. */
export const FRENCH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  "le",
  "la",
  "les",
  "des",
  "une",
  "est",
  "pas",
  "pour",
  "dans",
  "qui",
  "que",
  "sur",
  "avec",
  "donc",
  "mais",
  "sont",
  "cette",
  "du",
  "aux",
  "être",
  "où",
]);

/** Starting value to calibrate: a comment with at least this many function words is French. The two populations
 *  (18/11/2026, comments judged as `commentUnits` groups them): English comments wrongly reported, 0 of 372 in
 *  `docx-reader/`; French comments missed, 1 of 18 in `packages/reader/src/layout/gutter.ts` (« L'abscisse de la
 *  coupe. », one function word). An English comment that quotes French words is reported too, by decision: it counts
 *  until the quote is translated. */
export const FRENCH_WORD_THRESHOLD = 3;

export const FRENCH_COMMENT_RULE = "local/no-french-comment";

export function frenchWordCount(text: string): number {
  let count = 0;
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) if (FRENCH_FUNCTION_WORDS.has(word)) count += 1;
  return count;
}

type Comment = ReturnType<Rule.RuleContext["sourceCode"]["getAllComments"]>[number];

/** The comments as the rule judges them: a block alone, a `//` after code alone, and a passage of `//` lines that
 *  each hold only the comment, on consecutive lines, as one unit. */
export function commentUnits(comments: readonly Comment[], lines: readonly string[]): Comment[][] {
  const units: Comment[][] = [];
  let passage: Comment[] | undefined;
  for (const comment of comments) {
    const loc = comment.loc;
    const ownLine =
      !!loc && comment.type === "Line" && lines[loc.start.line - 1]!.slice(0, loc.start.column).trim() === "";
    const last = passage?.at(-1)?.loc;
    if (ownLine && passage && last && last.end.line + 1 === loc.start.line) passage.push(comment);
    else {
      passage = ownLine ? [comment] : undefined;
      units.push(passage ?? [comment]);
    }
  }
  return units;
}

const noFrenchComment: Rule.RuleModule = {
  meta: { type: "suggestion", schema: [], messages: { french: "Comment written in French: rewrite it in English." } },
  create(context) {
    return {
      Program() {
        const { sourceCode } = context;
        for (const unit of commentUnits(sourceCode.getAllComments(), sourceCode.lines)) {
          const loc = unit[0]!.loc;
          if (!loc || frenchWordCount(unit.map((comment) => comment.value).join("\n")) < FRENCH_WORD_THRESHOLD)
            continue;
          context.report({ loc, messageId: "french" });
        }
      },
    };
  },
};

/** The plugin that carries the rule, registered under the `local` prefix. */
export const localPlugin = { rules: { "no-french-comment": noFrenchComment } };

/** The first line of each French comment of a TypeScript source: the rule itself, run on one text. For the guard that
 *  holds `packages/` at zero, tests included (`tools/package-partition.test.ts`). A text that does not parse throws. */
export function frenchCommentLines(source: string): number[] {
  // A comment is part of the text: a file whose whole text stays below the threshold has no French comment to parse for.
  if (frenchWordCount(source) < FRENCH_WORD_THRESHOLD) return [];
  const messages = new Linter({ configType: "flat" }).verify(
    source,
    [
      {
        files: ["**/*.ts"],
        languageOptions: { parser },
        plugins: { local: localPlugin },
        rules: { [FRENCH_COMMENT_RULE]: "error" },
      },
    ],
    "source.ts",
  );
  const fatal = messages.find((message) => message.fatal === true);
  if (fatal) throw new Error(`the source does not parse, line ${String(fatal.line)}`);
  return messages.filter((message) => message.ruleId === FRENCH_COMMENT_RULE).map((message) => message.line);
}
