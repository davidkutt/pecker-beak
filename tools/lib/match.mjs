// Names → slugs, and "is this block the same thing?" for intake (plan.md §8, step 4).
// Pure functions: `beak find` and the duplicate guard in `beak save` both use them.

const GERMAN = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'ae', Ö: 'oe', Ü: 'ue', ß: 'ss', ẞ: 'ss' };

// Legal forms are dropped from the end of a name: "Acme Pharma GmbH" and "Acme Pharma" are the same block.
const LEGAL_FORMS = new Set([
  'ab', 'ag', 'bv', 'co', 'corp', 'ev', 'gbr', 'gmbh', 'inc', 'kg', 'kgaa', 'llc', 'llp', 'ltd', 'mbh',
  'nv', 'ohg', 'oy', 'plc', 'sa', 'sarl', 'se', 'spa', 'srl', 'ug',
]);

/** Score at or above which two names count as a likely match. */
export const LIKELY = 0.8;
const SLUG_MAX = 60;

/**
 * Normalised words of a name or id: lowercase ASCII, German umlauts spelled out, text in parentheses
 * dropped ("Acme Pharma (example customer)" → acme, pharma), trailing legal forms dropped.
 */
export function nameTokens(text) {
  const ascii = String(text ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[äöüÄÖÜßẞ]/g, (c) => GERMAN[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // "e.V.", "S.A." → "ev", "sa": dots between single letters belong to the abbreviation
    .replace(/\b([a-z])\.(?=[a-z]\b)/g, '$1');
  const tokens = ascii.split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_FORMS.has(tokens.at(-1))) tokens.pop();
  return tokens;
}

/** The slug intake proposes for a name: "Acme Pharma GmbH" → "acme-pharma". Empty if nothing is left. */
export function slugify(text) {
  let slug = nameTokens(text).join('-');
  if (slug.length > SLUG_MAX) {
    const cut = slug.lastIndexOf('-', SLUG_MAX);
    slug = slug.slice(0, cut > 0 ? cut : SLUG_MAX);
  }
  return slug;
}

/**
 * How alike two names are, from 0 to 1. Takes the best of:
 * - the spelling of both names without separators (catches typos and "acmepharma" vs "acme-pharma"),
 * - the share of words that match, in both directions (a word matches a longer word it starts),
 * - containment: every word of one name is in the other ("Acme" vs "Acme Pharma") scores LIKELY.
 */
export function similarity(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  const ca = ta.join('');
  const cb = tb.join('');
  if (ca === cb) return 1;
  const spelling = ratio(ca, cb);
  const ab = coverage(ta, tb);
  const ba = coverage(tb, ta);
  const words = (ab + ba) / 2;
  const contained = Math.max(ab, ba) >= 0.9 ? LIKELY : 0;
  // Two edits in a short name are a different name ("friendly-de" vs "friendly-en"), not a typo.
  return round(Math.max(spelling >= 0.85 ? spelling : 0, words, contained));
}

/**
 * Rank `blocks` (from loadLibrary) against a name. A block matches on its id or its "# Title".
 * Returns [{ kind: 'exact'|'likely', score, block }], best first; `exact` means the slug equals the id.
 */
export function rankBlocks(blocks, name, { type, exclude } = {}) {
  const slug = slugify(name);
  const matches = [];
  for (const block of blocks) {
    if (type && block.type !== type) continue;
    if (exclude && block.type === exclude.type && block.id === exclude.id) continue;
    if (slug && block.id === slug) {
      matches.push({ kind: 'exact', score: 1, block });
      continue;
    }
    const score = Math.max(similarity(name, block.id), block.title ? similarity(name, block.title.text) : 0);
    if (score >= LIKELY) matches.push({ kind: 'likely', score, block });
  }
  const order = { exact: 0, likely: 1 };
  return matches.sort(
    (x, y) => order[x.kind] - order[y.kind] || y.score - x.score || cmp(x.block.type, y.block.type) || cmp(x.block.id, y.block.id),
  );
}

// Average, over the words of x, of the best match among the words of y.
function coverage(x, y) {
  let sum = 0;
  for (const t of x) sum += Math.max(...y.map((u) => wordSimilarity(t, u)));
  return sum / x.length;
}

function wordSimilarity(t, u) {
  if (t === u) return 1;
  if (Math.min(t.length, u.length) >= 4 && (t.startsWith(u) || u.startsWith(t))) return 0.9;
  const r = ratio(t, u);
  return r >= 0.8 ? r : 0;
}

/** 1 - Levenshtein distance / length of the longer string. */
export function ratio(a, b) {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
