/**
 * The demo's retrieval, kept apart from the corpus on purpose.
 *
 * `library-demo.ts` holds the four captured jobs and is rendered into the page;
 * this module holds only the logic the browser needs, so the client bundle
 * carries no second copy of the answers — every word the demo says stays in the
 * markup. It is plain, pure functions with no DOM, which is what lets
 * `npm run check:demo` run a labeled battery of questions through it in CI.
 *
 * The rule is keyword overlap, and it is deliberately hard to fool into an
 * answer: a wrong answer with a confident source under it is worse than an
 * honest miss, and the miss state is part of what the page is claiming.
 */

/** One indexed entry: the id of the answer slip, keyed by its keyword index. */
export interface Matchable {
  id: string;
  match: string;
}

/**
 * Words that carry no retrieval signal — only the ones a plant question is
 * mostly made of.
 */
const STOP = new Set([
  'the', 'and', 'but', 'not', 'you', 'your', 'our', 'its', 'out', 'off', 'one', 'two', 'all',
  'any', 'can', 'could', 'should', 'would', 'get', 'got', 'has', 'have', 'had', 'was', 'were',
  'are', 'is', 'it', 'be', 'been', 'being', 'there', 'them', 'they', 'their', 'this', 'that',
  'then', 'than', 'these', 'those', 'how', 'why', 'what', 'where', 'when', 'which', 'who',
  'with', 'without', 'from', 'into', 'onto', 'over', 'under', 'about', 'after', 'before',
  'while', 'during', 'again', 'still', 'just', 'ever', 'never', 'always', 'does', 'did', 'done',
  'more', 'most', 'less', 'least', 'too', 'also', 'only', 'even', 'much', 'many', 'very',
  'some', 'both', 'each', 'other', 'another', 'same', 'such', 'own', 'new', 'old', 'see', 'say',
  'says', 'said', 'know', 'think', 'need', 'needs', 'want', 'like', 'make', 'makes', 'made',
  'use', 'used', 'using', 'work', 'works', 'working', 'thing', 'things', 'time', 'times',
  'day', 'days', 'week', 'weeks', 'start', 'started', 'please', 'help', 'problem', 'issue',
]);

/** Light stemming, so a typed word meets the index: "jamming" -> "jam". */
function stem(word: string): string {
  return word.replace(/(ing|ed|es|s)$/, '').replace(/([a-z])\1$/, '$1');
}

/** The words a question is asking with, stopwords and fragments dropped. */
export function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .map(stem)
    .filter((word) => word.length >= 3 && !STOP.has(word));
}

/** True when a typed word and an indexed keyword are the same word family. */
function related(query: string, indexed: string): boolean {
  return query === indexed || query.startsWith(indexed) || indexed.startsWith(query);
}

/** How many of the question's words the index knows, and how long they are. */
export function score(index: string, query: string[]): { matched: number; weight: number } {
  const indexed = keywords(index);
  let matched = 0;
  let weight = 0;
  for (const word of query) {
    const hits = indexed.filter((keyword) => related(word, keyword));
    if (!hits.length) continue;
    matched += 1;
    weight += Math.max(...hits.map((keyword) => keyword.length));
  }
  return { matched, weight };
}

/**
 * Two matched keywords retrieves; one retrieves only when the question is a
 * bare lookup ("cable", "door", "oil"). A sentence sharing a single keyword is
 * a coincidence — "how much coolant should the sump hold" must not retrieve the
 * answer about a coolant-bridged door switch.
 */
export function retrieves(query: string[], matched: number): boolean {
  return matched >= 2 || (matched === 1 && query.length === 1);
}

/** The id of the entry a typed question retrieves, or null for an honest miss. */
export function pick(query: string, entries: Matchable[]): string | null {
  const words = keywords(query);
  if (!words.length) return null;
  let best: { id: string; weight: number } | null = null;
  for (const entry of entries) {
    const { matched, weight } = score(entry.match, words);
    if (!retrieves(words, matched)) continue;
    if (!best || weight > best.weight) best = { id: entry.id, weight };
  }
  return best?.id ?? null;
}
