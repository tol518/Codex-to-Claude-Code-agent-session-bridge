# agent-session-bridge

This local tool turns Codex CLI/Desktop sessions into Claude Code sessions that `claude --resume` can open. The reverse direction, incremental handoff sync and more agents are planned.

Status: **Phase 0 (spikes and fixtures) is done.** No converter exists yet. See [`COMPAT.md`](COMPAT.md) for the verified format facts.

## Layout

- `COMPAT.md`: Phase 0 answers, with evidence and the pinned versions.
- `spikes/`: throwaway scripts that produced the evidence.
  - `minimal.mjs`: writes a minimal transcript.
  - `readback.mjs`: SDK L3 read-back.
  - `codex-inventory.mjs`: counts rollout types.
  - `sanitize-*.mjs`: fixture sanitizers.
- `fixtures/claude/2.1.268/`: sanitized Claude Code transcripts.
- `fixtures/codex/rollouts/`: sanitized Codex rollouts, plus `manifest.json`.
- `fixtures/codex/schema-*/`: the Codex app-server JSON schema snapshot.

All fixtures are sanitized. Every conversation text, command, output and path is replaced with filler of the same length. Only structure survives: entry types, ids, chain links and enum values.

## Principles

- Sources are read-only. Target files are only ever added, with an atomic `link()`, and never overwritten.
- Every write is journaled and backed up, and rollback happens only when the target's hash still matches what was written.
- Output is validated before an import counts: schema, invariants, official Agent SDK read-back, and an optional live resume.
- Nothing leaves the machine except the opt-in live resume check.

Requires Node 24+.

## License

[MIT](LICENSE)
