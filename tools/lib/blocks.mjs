// Block format (plan.md §4): Markdown with YAML frontmatter and a fixed set of sections.
// parseBlock() reads one file's structure; validateBlock() checks its frontmatter.
// Cross-file checks (ids that must exist, known consumers) live in lint.mjs.
import YAML from 'yaml';
import { SLUG_RE } from './config.mjs';

/** Block type → its folder under library/. */
export const BLOCK_TYPES = Object.freeze({
  task: 'tasks',
  scenario: 'scenarios',
  customer: 'customers',
  industry: 'industries',
  tone: 'tones',
  context: 'context',
});
export const TYPE_BY_DIR = Object.freeze(Object.fromEntries(Object.entries(BLOCK_TYPES).map(([t, d]) => [d, t])));

/** Body sections, in the order they must appear. */
export const SECTIONS = Object.freeze(['Purpose', 'Must include', 'Avoid', 'Examples', 'Done when']);

export const COMMON_KEYS = Object.freeze(['id', 'type', 'version', 'language', 'updated', 'checks']);
export const TYPE_KEYS = Object.freeze({
  task: Object.freeze(['consumer', 'output_format', 'test_inputs', 'runtime_vars', 'default_tone', 'golden']),
  scenario: Object.freeze(['input', 'notes']),
  customer: Object.freeze(['industry', 'default_tone']),
  industry: Object.freeze([]),
  tone: Object.freeze([]),
  context: Object.freeze([]),
});
const LANGUAGE_REQUIRED = new Set(['customer', 'tone']);

export const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
export const VAR_RE = /^[a-z][a-z0-9_]*$/;

const LIST_CHECKS = ['banned', 'required_phrases'];
export const NUMBER_CHECKS = Object.freeze(['max_words', 'min_words', 'max_chars', 'min_chars']);
/** Hard (deterministic) checks a block may add, per scope. */
export const CHECK_KEYS = Object.freeze({
  output: Object.freeze([...LIST_CHECKS, ...NUMBER_CHECKS]),
  prompt: Object.freeze(['required_sections', ...LIST_CHECKS, ...NUMBER_CHECKS]),
});

export const TODO_MARK = 'TODO:';
export const isTodo = (v) => typeof v === 'string' && v.includes(TODO_MARK);

/**
 * Parse one block file. Never throws; problems are returned in `findings`
 * ({ file, line, level: 'error'|'warning', message }).
 *
 * Returns {
 *   file, frontmatter (object|null), lineOf(path) → line number of a frontmatter value,
 *   title ({ text, line }|null), sections ([{ name, line, lines: [{ text, line }] }] in file order),
 *   section(name), doneWhen ([{ criterion, must, learned, line }]),
 *   examples ([{ label: 'good'|'bad'|null, text, line }]), todos ([{ text, line }]), findings
 * }
 */
export function parseBlock(text, file = '') {
  const findings = [];
  const add = (level, line, message) => findings.push({ file, line, level, message });
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const byName = new Map();
  const block = {
    file,
    frontmatter: null,
    lineOf: () => undefined,
    title: null,
    sections: [],
    section: (name) => byName.get(name),
    doneWhen: [],
    examples: [],
    todos: [],
    findings,
  };

  lines.forEach((t, i) => {
    if (t.includes(TODO_MARK)) block.todos.push({ text: t.trim(), line: i + 1 });
  });

  if (lines[0].trim() !== '---') {
    add('error', 1, 'must start with YAML frontmatter: a "---" line, the fields, then another "---" line');
    return block;
  }
  const end = lines.findIndex((t, i) => i > 0 && t.trim() === '---');
  if (end === -1) {
    add('error', 1, 'frontmatter is never closed: add a "---" line after the fields');
    return block;
  }

  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(lines.slice(1, end).join('\n'), { lineCounter });
  if (doc.errors.length) {
    for (const err of doc.errors) {
      const message = err.message.split('\n')[0].replace(/\s+at line \d+, column \d+:?\s*$/, '');
      add('error', 1 + (err.linePos?.[0]?.line ?? 0), `invalid YAML in frontmatter: ${message}`);
    }
  } else {
    const fm = doc.toJS();
    if (!isPlainObject(fm)) add('error', 2, 'frontmatter must be a list of "key: value" fields');
    else block.frontmatter = fm;
    // Line of the deepest existing node on `path` (offset by the opening "---" line).
    block.lineOf = (path) => {
      for (let n = path.length; n > 0; n--) {
        const node = doc.getIn(path.slice(0, n), true);
        if (node?.range) return 1 + lineCounter.linePos(node.range[0]).line;
      }
      return undefined;
    };
  }

  parseSections(lines, end + 1, block, add);
  checkSectionLayout(block, byName, add);
  parsePurpose(byName.get('Purpose'), add);
  parseDoneWhen(byName.get('Done when'), block, add);
  parseExamples(byName.get('Examples'), block, add);
  return block;
}

// Split the body into ## sections. Headings inside code fences are content.
function parseSections(lines, start, block, add) {
  let fence = null;
  let current = null;
  let strayReported = false;
  for (let i = start; i < lines.length; i++) {
    const text = lines[i];
    const line = i + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.len && !marker[2].trim()) fence = null;
      current?.lines.push({ text, line, fenced: true });
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], len: marker[1].length, line };
      if (current) current.lines.push({ text, line, fenced: true });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
    if (heading?.[1].length === 2) {
      current = { name: heading[2], line, lines: [] };
      block.sections.push(current);
      continue;
    }
    if (heading?.[1].length === 1) {
      if (!block.sections.length && !block.title) block.title = { text: heading[2], line };
      else add('error', line, 'a level-1 heading ("# …") is only allowed once, as a title above "## Purpose"');
      continue;
    }
    if (!current) {
      if (text.trim() && !strayReported) {
        add('error', line, 'text before the first section; the body must start with "## Purpose" (a "# Title" line is allowed)');
        strayReported = true;
      }
      continue;
    }
    current.lines.push({ text, line, fenced: false });
  }
  if (fence) add('error', fence.line, 'code fence is never closed');
}

function checkSectionLayout(block, byName, add) {
  const miscased = new Set();
  for (const s of block.sections) {
    if (!SECTIONS.includes(s.name)) {
      const canonical = SECTIONS.find((n) => n.toLowerCase() === s.name.toLowerCase());
      if (canonical) miscased.add(canonical);
      add(
        'error',
        s.line,
        canonical
          ? `section "## ${s.name}" must be written "## ${canonical}"`
          : `unknown section "## ${s.name}" (sections are: ${SECTIONS.join(', ')})`,
      );
    } else if (byName.has(s.name)) {
      add('error', s.line, `section "## ${s.name}" appears twice (first on line ${byName.get(s.name).line})`);
    } else {
      byName.set(s.name, s);
    }
  }
  const present = [...byName.keys()];
  const expected = SECTIONS.filter((n) => byName.has(n));
  const misplaced = present.findIndex((n, i) => n !== expected[i]);
  if (misplaced !== -1) {
    add('error', byName.get(present[misplaced]).line, `sections are out of order; the order is: ${SECTIONS.join(' → ')}`);
  }
  const missing = SECTIONS.filter((name) => !byName.has(name) && !miscased.has(name));
  if (missing.length) {
    const list = missing.map((n) => `"## ${n}"`).join(', ');
    add('error', undefined, `missing section${missing.length === 1 ? '' : 's'} ${list} (every block has all of: ${SECTIONS.join(', ')})`);
  }
}

function parsePurpose(section, add) {
  if (!section) return;
  const text = contentOf(section);
  if (!text) {
    add('error', section.line, '"## Purpose" is empty; say in 1–3 sentences what this block is for');
    return;
  }
  const sentences = (text.match(/[.!?](?=\s|$)/g) ?? []).length;
  if (sentences > 3) add('warning', section.line, `"## Purpose" should be 1–3 sentences (found ${sentences})`);
}

function parseDoneWhen(section, block, add) {
  if (!section) return;
  for (const { text, line, fenced } of section.lines) {
    if (!text.trim()) continue;
    const item = fenced ? null : /^[-*]\s+(.*)$/.exec(text);
    if (!item) {
      add('error', line, '"## Done when": each criterion must be one list item line starting with "- "');
      continue;
    }
    let criterion = item[1].trim();
    if (/^\[[ xX]\]\s/.test(criterion)) {
      add('error', line, '"## Done when": use plain list items, not checkboxes; mark blocking criteria with "[must]"');
      continue;
    }
    const must = /^\[must\]/i.test(criterion);
    if (must) criterion = criterion.replace(/^\[must\]\s*/i, '');
    let learned = null;
    const tag = /\s*\(learned ([^)]*)\)\s*$/.exec(criterion);
    if (tag) {
      if (!isValidDate(tag[1])) {
        add('error', line, `"## Done when": "(learned ${tag[1]})" needs a date like (learned 2026-11-06)`);
        continue;
      }
      learned = tag[1];
      criterion = criterion.slice(0, tag.index).trim();
    }
    if (!criterion) {
      add('error', line, '"## Done when": empty criterion');
      continue;
    }
    block.doneWhen.push({ criterion, must, learned, line });
  }
}

function parseExamples(section, block, add) {
  if (!section) return;
  let current = null;
  for (const { text, line, fenced } of section.lines) {
    if (!fenced) {
      const label = /^(Good|Bad):\s*(.*)$/.exec(text);
      if (label) {
        current = { label: label[1].toLowerCase(), line, lines: label[2] ? [label[2]] : [] };
        block.examples.push(current);
        continue;
      }
      if (/^\s*(good|bad)\s*:/i.test(text)) {
        add('warning', line, '"## Examples": write labels exactly as "Good:" or "Bad:" at the start of a line');
      }
    }
    if (!current) {
      if (!text.trim()) continue;
      current = { label: null, line, lines: [] };
      block.examples.push(current);
    }
    current.lines.push(text);
  }
  for (const ex of block.examples) {
    ex.text = trimBlankLines(ex.lines).join('\n');
    delete ex.lines;
  }
}

/** Check one block's frontmatter. `expectedType` / `expectedId` come from its folder and filename. */
export function validateBlock(block, { expectedType, expectedId } = {}) {
  const fm = block.frontmatter;
  if (!fm) return [];
  const findings = [];
  // `where` is a frontmatter path (e.g. ['checks', 'output']) or a line number.
  const add = (level, where, message) =>
    findings.push({ file: block.file, line: typeof where === 'number' ? where : block.lineOf(where), level, message });

  if (fm.id === undefined) add('error', ['id'], 'missing "id"');
  else if (typeof fm.id !== 'string' || !SLUG_RE.test(fm.id)) {
    add('error', ['id'], `id ${fmt(fm.id)} must be a lowercase slug (a-z, 0-9, single hyphens)`);
  } else if (expectedId !== undefined && fm.id !== expectedId) {
    add('error', ['id'], `id "${fm.id}" must equal the filename "${expectedId}.md" (rename the file or change the id)`);
  }

  if (fm.type === undefined) add('error', ['type'], `missing "type" (one of: ${Object.keys(BLOCK_TYPES).join(', ')})`);
  else if (!(fm.type in BLOCK_TYPES)) {
    add('error', ['type'], `type ${fmt(fm.type)} must be one of: ${Object.keys(BLOCK_TYPES).join(', ')}`);
  } else if (expectedType && fm.type !== expectedType) {
    add('error', ['type'], `type "${fm.type}" does not match its folder ${BLOCK_TYPES[expectedType]}/ (expected "${expectedType}")`);
  }

  if (fm.version === undefined) add('error', ['version'], 'missing "version" (start at 1, bump on every content edit)');
  else if (!Number.isInteger(fm.version) || fm.version < 1) {
    add('error', ['version'], `version must be a whole number >= 1 (got ${fmt(fm.version)})`);
  }

  if (fm.updated === undefined) add('error', ['updated'], 'missing "updated" (a date like 2026-11-06)');
  else if (typeof fm.updated !== 'string' || !isValidDate(fm.updated)) {
    add('error', ['updated'], `updated must be a date like 2026-11-06 (got ${fmt(fm.updated)})`);
  }

  // The folder decides the type (it is how other blocks find this one); a mismatch is reported above.
  const type = expectedType ?? (fm.type in BLOCK_TYPES ? fm.type : undefined);
  if (fm.language === undefined) {
    if (LANGUAGE_REQUIRED.has(type)) add('error', [], `a ${type} needs "language" (e.g. de, en)`);
  } else if (!isTodo(fm.language) && (typeof fm.language !== 'string' || !LANGUAGE_RE.test(fm.language))) {
    add('error', ['language'], `language ${fmt(fm.language)} must be a language code such as de, en or de-CH`);
  }

  if (type) {
    const allowed = [...COMMON_KEYS, ...TYPE_KEYS[type]];
    for (const key of Object.keys(fm)) {
      if (allowed.includes(key)) continue;
      const owner = Object.keys(TYPE_KEYS).find((t) => TYPE_KEYS[t].includes(key));
      add(
        'error',
        [key],
        owner
          ? `"${key}" does not belong in a ${type} block (it is a ${owner} field)`
          : `unknown field "${key}" (a ${type} block allows: ${allowed.join(', ')})`,
      );
    }
  }

  if (fm.checks !== undefined) validateChecks(fm.checks, add);

  if (type === 'task') validateTask(fm, block, add);
  if (type === 'customer') {
    requireId(fm, 'industry', 'an industry id', add);
    requireId(fm, 'default_tone', 'a tone id', add);
  }
  if (type === 'scenario') {
    if (fm.input === undefined) add('error', [], 'a scenario needs "input": the sample user message for test runs');
    else if (!nonEmptyString(fm.input)) add('error', ['input'], 'input must be non-empty text');
    if (fm.notes !== undefined && typeof fm.notes !== 'string') add('error', ['notes'], 'notes must be text');
  }
  return findings;
}

function validateTask(fm, block, add) {
  requireId(fm, 'consumer', 'a consumer agent name from beak.config.yaml', add);

  if (fm.output_format === undefined) {
    add('error', [], 'a task needs "output_format": the sections the generated prompt must have');
  } else if (!stringList(fm.output_format) || fm.output_format.length === 0) {
    add('error', ['output_format'], 'output_format must be a non-empty list of section names');
  } else {
    warnDuplicates(fm.output_format, ['output_format'], add);
  }

  if (fm.test_inputs === undefined) {
    add('error', [], 'a task needs "test_inputs": scenario ids or { id, input } entries');
  } else if (!Array.isArray(fm.test_inputs) || fm.test_inputs.length === 0) {
    add('error', ['test_inputs'], 'test_inputs must be a non-empty list of scenario ids or { id, input } entries');
  } else {
    const seen = new Set();
    fm.test_inputs.forEach((item, i) => {
      const path = ['test_inputs', i];
      let id;
      if (typeof item === 'string') {
        if (!SLUG_RE.test(item)) return add('error', path, `test_inputs[${i}] ${fmt(item)} must be a scenario id`);
        id = item;
      } else if (isPlainObject(item)) {
        const extra = Object.keys(item).filter((k) => k !== 'id' && k !== 'input');
        if (extra.length) add('error', path, `test_inputs[${i}] has unknown fields: ${extra.join(', ')} (only id and input)`);
        if (typeof item.id !== 'string' || !SLUG_RE.test(item.id)) {
          return add('error', path, `test_inputs[${i}] needs an "id" slug`);
        }
        if (!nonEmptyString(item.input)) add('error', path, `test_inputs[${i}] ("${item.id}") needs non-empty "input" text`);
        id = item.id;
      } else {
        return add('error', path, `test_inputs[${i}] must be a scenario id or { id, input }`);
      }
      if (seen.has(id)) add('error', path, `test_inputs: "${id}" is listed twice`);
      seen.add(id);
    });
  }

  if (fm.runtime_vars !== undefined) {
    if (!stringList(fm.runtime_vars) || fm.runtime_vars.some((v) => !VAR_RE.test(v))) {
      add('error', ['runtime_vars'], 'runtime_vars must be a list of names like lead_name (lowercase, digits, underscores)');
    } else {
      warnDuplicates(fm.runtime_vars, ['runtime_vars'], add);
    }
  }

  if (fm.default_tone !== undefined) requireId(fm, 'default_tone', 'a tone id', add);
  if (fm.golden !== undefined && !nonEmptyString(fm.golden)) {
    add('error', ['golden'], 'golden must be a path to the approved reference prompt');
  }

  const doneWhen = block.section('Done when');
  if (doneWhen && block.doneWhen.length === 0) {
    add('error', doneWhen.line, 'a task needs at least one criterion under "## Done when"');
  }
}

function validateChecks(checks, add) {
  if (!isPlainObject(checks)) {
    add('error', ['checks'], 'checks must be a mapping with "output" and/or "prompt"');
    return;
  }
  for (const [scope, rules] of Object.entries(checks)) {
    const at = ['checks', scope];
    if (!(scope in CHECK_KEYS)) {
      add('error', at, `checks.${scope} is not a check scope (use output or prompt)`);
      continue;
    }
    if (rules === null) continue;
    if (!isPlainObject(rules)) {
      add('error', at, `checks.${scope} must be a mapping of checks`);
      continue;
    }
    for (const [key, value] of Object.entries(rules)) {
      const path = [...at, key];
      const name = `checks.${scope}.${key}`;
      if (!CHECK_KEYS[scope].includes(key)) {
        add('error', path, `unknown check ${name} (allowed: ${CHECK_KEYS[scope].join(', ')})`);
      } else if (NUMBER_CHECKS.includes(key)) {
        if (!Number.isInteger(value) || value < 0) add('error', path, `${name} must be a whole number >= 0 (got ${fmt(value)})`);
      } else if (!stringList(value) || value.some((s) => !s.trim())) {
        add('error', path, `${name} must be a list of non-empty strings`);
      } else {
        warnDuplicates(value, path, add);
      }
    }
    for (const unit of ['words', 'chars']) {
      const min = rules[`min_${unit}`];
      const max = rules[`max_${unit}`];
      if (Number.isInteger(min) && Number.isInteger(max) && min > max) {
        add('error', [...at, `min_${unit}`], `checks.${scope}.min_${unit} (${min}) is larger than max_${unit} (${max})`);
      }
    }
  }
}

function requireId(fm, key, what, add) {
  const v = fm[key];
  if (v === undefined) add('error', [], `missing "${key}" (${what})`);
  else if (isTodo(v)) return;
  else if (typeof v !== 'string' || !SLUG_RE.test(v)) add('error', [key], `${key} ${fmt(v)} must be ${what} (a lowercase slug)`);
}

function warnDuplicates(list, path, add) {
  const dup = list.filter((v, i) => list.indexOf(v) !== i);
  if (dup.length) add('warning', path, `${path.join('.')} lists ${[...new Set(dup)].map((d) => `"${d}"`).join(', ')} more than once`);
}

export function isValidDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

function contentOf(section) {
  return section.lines
    .map((l) => l.text)
    .join('\n')
    .trim();
}

function trimBlankLines(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

function stringList(v) {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function fmt(v) {
  return v === undefined ? 'nothing' : JSON.stringify(v);
}
