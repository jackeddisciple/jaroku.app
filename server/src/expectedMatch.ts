// Checking an answer against what a case expected — without a model.
//
// `expected` WAS ONLY EVER HANDED TO THE JUDGE. With no judge (production has none unless a workspace
// turns its own key on) a case's expected output did nothing at all, and with one it was a hint to a
// model rather than a check anybody could reason about. These are the checks a person can predict:
// the same answer, an answer that contains it, an answer that says the word, or one a pattern matches.
//
// Pure, so it is tested without a database; the aggregate calls it per cell, from the answer each job
// kept (migration 092) and the mode the eval started with (migration 094).

export const CHECK_MODES = ["exact", "contains", "word", "regex"] as const;
export type CheckMode = (typeof CHECK_MODES)[number];

export function isCheckMode(v: unknown): v is CheckMode {
  return typeof v === "string" && (CHECK_MODES as readonly string[]).includes(v);
}

/** The longest pattern a regex check takes. A case's expectation, not a program. */
export const MAX_PATTERN = 200;

/** Case and runs of whitespace do not make two answers different. */
const fold = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern this server will run, or the sentence saying why it will not.
 *
 * THE PATTERN COMES FROM A DATASET AND RUNS ON A SHARED SERVER, so a nested quantifier — `(a+)+`, the
 * shape that backtracks exponentially — is refused rather than run, and so is anything long.
 */
export function checkPattern(pattern: string): { re: RegExp } | { error: string } {
  if (pattern.length > MAX_PATTERN) return { error: `a pattern can be at most ${MAX_PATTERN} characters` };
  if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(pattern)) return { error: "a repeated group inside a repeat is not run — it can take for ever" };
  try {
    return { re: new RegExp(pattern, "i") };
  } catch (err) {
    return { error: `not a valid pattern: ${(err as Error).message}` };
  }
}

/**
 * Whether `output` meets `expected` under `mode`: true, false, or null when there is nothing to check
 * (no expectation, no answer, no mode) — which is "not checked", never "failed".
 */
export function matchesExpected(mode: CheckMode | null | undefined, expected: string | null | undefined, output: string | null | undefined): boolean | null {
  if (!mode || !expected || !expected.trim() || output === null || output === undefined) return null;
  switch (mode) {
    case "exact":
      return fold(output) === fold(expected);
    case "contains":
      return fold(output).includes(fold(expected));
    case "word":
      return new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(fold(expected))}($|[^\\p{L}\\p{N}_])`, "u").test(fold(output));
    case "regex": {
      const checked = checkPattern(expected.trim());
      return "re" in checked ? checked.re.test(output) : null;
    }
  }
}
