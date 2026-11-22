[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AdnanBoot/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/AdnanBoot/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` applies AI-generated file patches to a working tree as specified in [SPEC.md](SPEC.md).

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is a path relative to the working directory; when omitted or `-`, the patch is read from standard input.
- `--format=NAME` selects `auto` (default), `unified`, `search-replace`, `v4a`, or `json`.
- `--check` runs validation and prints the same output and exit code without writing any changes to disk.
- `--strict` restricts line matching to exact matches (tier 0 only).

## Behaviour and Output

- **All-or-nothing:** Every edit is parsed before any file is read, and all edits are applied in order to an in-memory tree. If any edit fails, nothing is written to disk.
- **Exit 2:** Usage, unreadable patch, undetected format, or parse errors (`error: usage`, `error: no-patch`, `error: format`, `error: parse <N>`).
- **Exit 1:** Per-edit failures (`error: <code> <path>`) followed by `failed: <k> of <n> edits`.
- **Exit 0:** Sorted file changes (`A`, `D`, `M`, or `R <old> -> <new>` for moves) followed by `ok: <n> files` (or `ok: 1 file`).

## Testing

Run the practice suite (using `practice.json` from the kit's `program/generator` directory) and the edge-case tests:

```sh
node check.ts practice.json
node edge-tests.ts
```

## Runtime and License

Requires Node.js 22 using the standard library only. Licensed under the MIT License ([LICENSE](LICENSE)).

Built for the [hidden-spec-cli-01 bounty on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122). Referral: [make.fun/r/26nwh9gf](https://make.fun/r/26nwh9gf).
