// Script-made library changes after a review (plan.md §9): a learned "## Done when" line (beak reject,
// beak learn) and the task's golden path (beak approve --golden). Each one bumps the block's version and sets
// `updated` with setFrontmatterFields(), and is linted together with the library before anything is written.
import fs from 'node:fs';
import { BLOCK_TYPES, parseBlock } from './blocks.mjs';
import { blockType, setFrontmatterFields } from './intake.mjs';
import { loadLibrary } from './library.mjs';
import { formatFindings, lint } from './lint.mjs';
import { BeakError, relPath } from './util.mjs';

/** A block by "id" or "type/id" (type or folder name, e.g. tone/formal-de or tones/formal-de). */
export function findBlock(library, ref) {
  if (typeof ref !== 'string' || !ref.trim()) throw new BeakError('name the block, e.g. formal-de or tone/formal-de', 2);
  const [a, b] = ref.split('/');
  if (b !== undefined) {
    const type = blockType(a);
    if (!type) throw new BeakError(`"${a}" is not a block type (${Object.keys(BLOCK_TYPES).join(', ')})`, 2);
    const block = library.byType[type].get(b);
    if (!block) throw new BeakError(`there is no ${type} "${b}" in the library`);
    return block;
  }
  const found = library.blocks.filter((x) => x.id === a);
  if (!found.length) throw new BeakError(`there is no block "${a}" in the library`);
  if (found.length > 1) throw new BeakError(`"${a}" is the id of several blocks (${found.map((x) => `${x.type}/${x.id}`).join(', ')}); write type/id`, 2);
  return found[0];
}

/**
 * Normalise a criterion the model proposed: drop a leading "- ", "[must]" (→ must) and a "(learned …)" tag.
 * Returns { text, must }. Throws a usage error for an empty or multi-line criterion.
 */
export function normalizeCriterion(raw, must = false) {
  let text = String(raw ?? '').trim();
  if (/\n/.test(text)) throw new BeakError('a criterion is one line', 2);
  text = text.replace(/^[-*](?:\s+|$)/, '');
  if (/^\[must\]/i.test(text)) {
    must = true;
    text = text.replace(/^\[must\]\s*/i, '');
  }
  text = text.replace(/\s*\(learned [^)]*\)\s*$/, '').trim();
  if (!text) throw new BeakError('the criterion is empty', 2);
  return { text, must };
}

/** Insert a Done-when line at the end of the "## Done when" section of a block's text. */
export function insertDoneWhen(text, line) {
  const parsed = parseBlock(text);
  const section = parsed.section('Done when');
  if (!section) throw new BeakError('the block has no "## Done when" section');
  const lines = text.split('\n');
  const content = section.lines.filter((l) => l.text.trim());
  if (content.length) {
    lines.splice(content.at(-1).line, 0, line); // after the last non-blank line of the section
  } else {
    lines.splice(section.line, 0, '', line); // right after the heading
  }
  return lines.join('\n');
}

/**
 * Plan adding a learned criterion to a block. Returns { block, text, line, version, previous } where `text`
 * is the new file content. Throws BeakError if the criterion is already there or the result does not lint.
 */
export function planDoneWhen({ config, library, ref, criterion, must = false, today }) {
  const block = findBlock(library, ref);
  const c = normalizeCriterion(criterion, must);
  const same = block.doneWhen.find((d) => d.criterion.toLowerCase() === c.text.toLowerCase());
  if (same) throw new BeakError(`${block.type}/${block.id} already has this criterion (line ${same.line})`);
  const line = `- ${c.must ? '[must] ' : ''}${c.text} (learned ${today})`;
  const inserted = insertDoneWhen(fs.readFileSync(block.path, 'utf8'), line);
  return { ...stamp({ config, block, text: inserted, today }), line };
}

/**
 * Plan setting the task's `golden:` path. Returns null when it already points there.
 * The golden file is about to be written, so lint's "golden not found" for exactly that path is ignored.
 */
export function planGolden({ config, library, taskId, golden, today }) {
  const block = library.byType.task.get(taskId);
  if (!block) throw new BeakError(`task "${taskId}" is not in the library any more; cannot set its golden prompt`);
  if (block.frontmatter?.golden === golden) return null;
  const text = fs.readFileSync(block.path, 'utf8');
  let updated;
  if (block.frontmatter?.golden !== undefined) {
    updated = setFrontmatterFields(text, [['golden', golden]])?.text;
  } else {
    // A new field goes where the template has it: before `checks:`, or at the end of the frontmatter.
    const lines = text.split('\n');
    const end = lines.findIndex((t, i) => i > 0 && t.trim() === '---');
    const checks = lines.findIndex((t, i) => i > 0 && i < end && /^checks\s*:/.test(t));
    lines.splice(checks === -1 ? end : checks, 0, `golden: ${golden}`);
    updated = lines.join('\n');
  }
  if (!updated) throw new BeakError(`${relPath(config.root, block.path)}: frontmatter could not be read`);
  return stamp({ config, block, text: updated, today, ignore: (f) => f.message.startsWith(`golden "${golden}" not found`) });
}

// Bump version, set updated, and lint the result in the context of the whole library.
function stamp({ config, block, text, today, ignore = () => false }) {
  const previous = block.frontmatter.version;
  if (!Number.isInteger(previous) || previous < 1) throw new BeakError(`${relPath(config.root, block.path)} has no valid version; fix it by hand first`);
  const version = previous + 1;
  const stamped = setFrontmatterFields(text, [['version', String(version)], ['updated', today]]);
  const overlay = new Map([[block.path, stamped.text]]);
  const errors = lint({ config, overlay, target: block.path }).findings.filter((f) => f.level === 'error' && !ignore(f));
  if (errors.length) throw new BeakError(`the change would break ${relPath(config.root, block.path)}:\n${formatFindings(errors).map((l) => `  ${l}`).join('\n')}`);
  return { block, text: stamped.text.endsWith('\n') ? stamped.text : `${stamped.text}\n`, version, previous };
}

export function applyEdit(edit) {
  fs.writeFileSync(edit.block.path, edit.text);
}

export function reloadLibrary(config) {
  return loadLibrary(config.dirs.library, { root: config.root });
}
