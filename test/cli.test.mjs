import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../tools/beak.mjs';

const CLI = fileURLToPath(new URL('../tools/beak.mjs', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function beak(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('--help prints usage and every planned command', () => {
  const r = beak('--help');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: beak <command>/);
  for (const name of ['lint', 'bundle', 'test', 'check', 'judge', 'score', 'loop-status', 'finalize', 'approve', 'reject']) {
    assert.ok(COMMANDS.some((c) => c.name === name), `COMMANDS is missing ${name}`);
    assert.match(r.stdout, new RegExp(`^  ${name}\\b`, 'm'), `help is missing ${name}`);
  }
});

test('no arguments prints help', () => {
  const r = beak();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: beak/);
});

test('--version prints the package version', () => {
  const r = beak('--version');
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('unknown command is a usage error', () => {
  const r = beak('frobnicate');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command "frobnicate"/);
});

test('<command> --help prints that command usage', () => {
  const r = beak('bundle', '--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Usage: beak bundle key=value/);
  assert.match(r.stdout, /task \(required\)/);
});

test('a command that is not built yet fails and names its milestone', () => {
  const pending = COMMANDS.find((c) => !c.run);
  if (!pending) return; // every command is built
  const r = beak(pending.name);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`not built yet \\(planned for ${pending.milestone}`));
});

test('package.json bin points at the CLI and the CLI is executable', () => {
  assert.equal(pkg.bin.beak, 'tools/beak.mjs');
  const mode = fs.statSync(CLI).mode;
  assert.ok(mode & 0o111, 'tools/beak.mjs should be executable');
  assert.ok(fs.readFileSync(CLI, 'utf8').startsWith('#!/usr/bin/env node\n'));
});
