#!/usr/bin/env node
// Beak CLI entry (plan.md §6). Commands are thin wrappers over tools/lib/*.mjs.
// Exit codes: 0 ok, 1 failure, 2 usage error.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundleCommand } from './lib/bundle.mjs';
import { findCommand, saveCommand } from './lib/intake.mjs';
import { lintCommand } from './lib/lint.mjs';

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

// `milestone` marks commands that are planned but not built yet; drop it once a command has a `run`.
export const COMMANDS = [
  {
    group: 'Library',
    name: 'lint',
    usage: 'lint [path]',
    summary: 'Validate library blocks',
    detail: 'path: a block file or folder inside the library (default: the whole library). Exit 1 if there are errors.',
    run: lintCommand,
  },
  {
    name: 'find',
    usage: 'find <name…> [type=…]',
    summary: 'Find blocks with a similar name, and the slug for a new one',
    detail:
      'Prints "slug: …", then one line per similar block ("exact:" = same id, "likely:" = similar name or title),\n' +
      'and with type= the file a new block would go to ("new: …"). type: task, scenario, customer, industry, tone, context.',
    run: findCommand,
  },
  {
    name: 'save',
    usage: 'save <file…> [--check] [--new] [--drop-examples]',
    summary: 'Move staged blocks from library/_intake/ into the library',
    detail:
      'The block goes to library/<type folder>/<id>.md. Sets version (1 when new, +1 when the content changed)\n' +
      'and updated (today), lints the result and removes the staged file. Writes nothing if anything is wrong:\n' +
      'lint errors, a new block that looks like an existing one (--new overrides after the user confirms),\n' +
      'or an existing example that was changed or removed (--drop-examples, only if the user asked).\n' +
      '--check: report what would happen, write nothing.',
    run: saveCommand,
  },
  {
    group: 'Compose and quality loop',
    name: 'bundle',
    usage: 'bundle key=value…',
    summary: 'Create a run folder with bundle.md, rubric.json and meta.json',
    detail:
      'Keys: task (required), customer, industry, tone, scenario, context (ids separated by commas), tester, judge.\n' +
      'A customer brings its industry and default tone unless they are given; the tone falls back to the task\'s\n' +
      'default_tone. Give customer= or industry=. tester/judge pick a model from beak.config.yaml for this run\n' +
      '(default: roles:). Writes runs/<run-id>/ (bundle.md, rubric.json, meta.json, inputs.json, round-0/) and\n' +
      'prints the run id. Warnings go to stderr.',
    run: bundleCommand,
  },
  { name: 'test', usage: 'test <run> <round>', summary: 'Run the candidate prompt on each test input', milestone: 'M4' },
  { name: 'check', usage: 'check <run> <round>', summary: 'Hard checks on the prompt and outputs', milestone: 'M4' },
  { name: 'judge', usage: 'judge <run> <round>', summary: 'Judge the outputs against the rubric', milestone: 'M4' },
  { name: 'score', usage: 'score <run> <round>', summary: 'Combine checks and judge into a scorecard', milestone: 'M4' },
  { name: 'loop-status', usage: 'loop-status <run>', summary: 'Print CONTINUE or STOP <reason>', milestone: 'M4' },
  { name: 'finalize', usage: 'finalize <run>', summary: 'Copy the best round to drafts/', milestone: 'M4' },
  {
    group: 'Review',
    name: 'approve',
    usage: 'approve <draft> [--golden]',
    summary: 'Route a draft to out/<consumer>/ and commit',
    milestone: 'M5',
  },
  {
    name: 'reject',
    usage: 'reject <draft> --reason "…" [--block id]',
    summary: 'Record a rejection as a Done-when line',
    milestone: 'M5',
  },
];

export function version() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

export function helpText() {
  const width = Math.max(...COMMANDS.map((c) => c.usage.length)) + 2;
  const lines = [
    'beak: compose prompts from versioned blocks, test them in a quality loop, approve and route them',
    '',
    'Usage: beak <command> [args]',
    '       beak <command> --help',
  ];
  for (const c of COMMANDS) {
    if (c.group) lines.push('', c.group);
    const status = c.milestone ? `  (not built yet: ${c.milestone})` : '';
    lines.push(`  ${c.usage.padEnd(width)}${c.summary}${status}`);
  }
  lines.push(
    '',
    'Options',
    '  -h, --help     Show this help',
    '  -v, --version  Show the version',
    '',
    'Environment',
    '  BEAK_RUNNER    Overrides `runner:` in beak.config.yaml (pi | fake)',
    '',
    'Plan and contracts: plan.md',
  );
  return lines.join('\n');
}

export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
  const [first, ...rest] = argv;

  if (first === undefined || first === '-h' || first === '--help' || first === 'help') {
    io.out.write(helpText() + '\n');
    return EXIT_OK;
  }
  if (first === '-v' || first === '--version') {
    io.out.write(version() + '\n');
    return EXIT_OK;
  }

  const cmd = COMMANDS.find((c) => c.name === first);
  if (!cmd) {
    io.err.write(`beak: unknown command "${first}". Run "beak --help" for the list.\n`);
    return EXIT_USAGE;
  }
  if (rest.includes('-h') || rest.includes('--help')) {
    io.out.write(`Usage: beak ${cmd.usage}\n\n${cmd.summary}\n${cmd.detail ? `${cmd.detail}\n` : ''}`);
    return EXIT_OK;
  }
  if (!cmd.run) {
    io.err.write(`beak ${cmd.name}: not built yet (planned for ${cmd.milestone}, see plan.md §13)\n`);
    return EXIT_FAIL;
  }
  return cmd.run(rest, io);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`beak: ${err.message}\n`);
      process.exitCode = EXIT_FAIL;
    },
  );
}
