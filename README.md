# Codex to Claude Code agent session bridge

This local tool turns Codex CLI/Desktop sessions into Claude Code sessions that `claude --resume` can open. The reverse direction, incremental handoff sync and more agents are planned.

Status: **Phase 1 is done.** Codex → Claude Code import works in transcript mode, with the full safety engine. Native tool-call fidelity, images, and the context budget come in Phase 2. See [`COMPAT.md`](COMPAT.md) for the verified format facts.

## Usage

```bash
npm install
./bin/asb list                      # your Codex threads and their import state
./bin/asb import <thread-id>        # unique id prefixes work; add --dry-run to only render + validate
./bin/asb import --all-native       # every real Codex conversation (skips subagent/guardian threads and Codex's own Claude imports)
cd <project> && claude --resume <session-id>   # the id works from any folder; cd first so Claude's tools run in the right project
./bin/asb status                    # ok / missing (Claude cleaned it up) / continued (you kept going in Claude)
./bin/asb restore                   # rewrite copies Claude's 30-day cleanup deleted
./bin/asb rollback <session-id>     # remove an import, only if you have not continued it (backup kept)
```

### Showing imports in the desktop app's Code tab

The sidebar reads the app's own session registry, not `~/.claude/projects`. After `asb import`, run the app's own importer once: **Help → Troubleshooting → Import Claude Code CLI Sessions…**. Each session lands in the group for the folder Codex worked in, for example `~/openclaw`.

The app only offers sessions from folders you have trusted in Claude. Open a folder in the Code tab once to trust it, then run the importer again.

After upgrading asb, run `asb refresh` **before** the app import. It re-renders untouched imports: the new copy is written and verified first, then the old one is removed.

### How a Codex thread shows up in Claude

- The first entry is a hidden note. It tells Claude the history came from Codex.
- The title is `Codex: <thread name>`.
- User and assistant messages are kept as written.
- Codex's tool calls become short capped lines inside the assistant's text:
  ```
  ▸ ran `pnpm test` → exit 1 · 2 failed
  ▸ edited src/auth/login.ts (+3 −1)
  ▸ called playwright.browser_navigate → ok
  ```
- IDE and browser context that Codex attached to your messages is left out.
- Codex's encrypted reasoning cannot be read, so it is dropped. Pass `--include-reasoning` to include the readable reasoning summaries.

### Where data lives

- **Sources:** `~/.codex` is only ever read.
- **Claude side:** files in `~/.claude/projects/<folder>/` are only created, never overwritten. The tool deletes one only when its bytes still match what it wrote.
- **Store:** `~/Library/Application Support/agent-session-bridge/asb.sqlite` (mode 0600). It keeps:
  - the raw source bytes, with images deduplicated and a byte-exact round-trip check;
  - every written transcript;
  - an operation journal. A `kill -9` at any step recovers on the next run.
- **Overrides:** `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `ASB_HOME`.

### Known limits (Phase 1)

- Codex Desktop scans `~/.claude/projects` and **will offer imported sessions back** under "import from Claude". Ignore those offers; loop prevention arrives in Phase 3.
- A thread that grew after import is refused until Phase 4's append. Pass `--new-generation` to write a fresh, separate copy.

## Development

```bash
npm test            # vitest, every test on temp CODEX_HOME/CLAUDE_CONFIG_DIR/ASB_HOME
npm run typecheck
```

## Layout

- `src/`: `codex/` (thread index, reader), `claude/` (paths, L1 schema, transcript renderer), `store.ts`, `safety.ts`, `validate.ts`, `importer.ts` and `cli.ts`.
- `test/`: reader, renderer (property test) and importer/safety tests, including real SIGKILL recovery.
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
