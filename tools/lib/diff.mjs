// A small line diff (longest common subsequence) for `beak review`: the draft against the golden prompt.

/** Line operations turning `a` into `b`: [{ op: ' '|'-'|'+', text }]. */
export function diffLines(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push({ op: ' ', text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ op: '-', text: x[i++] });
    else ops.push({ op: '+', text: y[j++] });
  }
  while (i < n) ops.push({ op: '-', text: x[i++] });
  while (j < m) ops.push({ op: '+', text: y[j++] });
  return ops;
}

/**
 * Unified diff text with `context` unchanged lines around each change. Empty string when equal.
 * Hunk headers are "@@ -a,b +c,d @@" like `diff -u`.
 */
export function unifiedDiff(a, b, { from = 'a', to = 'b', context = 3 } = {}) {
  const ops = diffLines(a, b);
  if (ops.every((o) => o.op === ' ')) return '';
  // Line numbers of each op in a and b (1-based, before the op).
  let la = 1;
  let lb = 1;
  const numbered = ops.map((o) => {
    const at = { ...o, a: la, b: lb };
    if (o.op !== '+') la++;
    if (o.op !== '-') lb++;
    return at;
  });
  const changed = numbered.map((o, k) => (o.op !== ' ' ? k : -1)).filter((k) => k >= 0);
  const hunks = [];
  for (const k of changed) {
    const start = Math.max(0, k - context);
    const end = Math.min(numbered.length - 1, k + context);
    const last = hunks.at(-1);
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }
  const out = [`--- ${from}`, `+++ ${to}`];
  for (const h of hunks) {
    const lines = numbered.slice(h.start, h.end + 1);
    const aLen = lines.filter((o) => o.op !== '+').length;
    const bLen = lines.filter((o) => o.op !== '-').length;
    out.push(`@@ -${lines[0].a},${aLen} +${lines[0].b},${bLen} @@`);
    for (const o of lines) out.push(`${o.op}${o.text}`);
  }
  return out.join('\n');
}
