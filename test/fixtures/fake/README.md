# Canned responses for the fake runner

`BEAK_RUNNER=fake` answers test and judge calls from this folder (or from `BEAK_FAKE_DIR`). No model is called.

For a call with role `tester` or `judge` and key `round-2/<input-id>` (judge: `round-2`, or `round-2/sample-1` with several judge samples, and `…/attempt-2` for the retry after an invalid reply), the first file that exists is used:

1. `<role>/round-2/<input-id>.md` (or `.json`, `.txt`)
2. `<role>/round-2.md`
3. `<role>/default.md`

- A file containing `FAIL` (or `FAIL: message`) makes the call fail like a broken runner.
- A judge file `{ "auto": { "score": 70, "fail": ["C2", "C5@cold-first-contact"], "no_evidence": ["C1"], "top_issues": [] } }` becomes a complete judge reply: every requested verdict passes (quoting the output's first line as evidence) except the listed ones.

The files here make the example run (`task=cold-email customer=acme-pharma`) pass in round 0. Tests build their own folders in a temp dir.
