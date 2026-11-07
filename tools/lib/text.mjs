// Text matching shared by the merge rules (beak bundle) and the hard checks (beak check, M4).

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does `text` contain `phrase`? Case-insensitive, as a whole word or phrase: "Hallo" matches "Hallo Anna" and
 * "hallo!", not "Hallorenkugeln". Runs of whitespace in the phrase match any whitespace.
 */
export function containsPhrase(text, phrase) {
  const words = phrase.trim().split(/\s+/).map(escape).join('\\s+');
  if (!words) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}
