# COMPAT: Phase 0 evidence

Pinned versions this evidence was gathered against (2026-09-25, macOS):

| Component | Version |
| --- | --- |
| Claude Code CLI | 2.1.268 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.268 (its `claudeCodeVersion` is 2.1.268) |
| Codex CLI (inside ChatGPT.app) | 0.155.0-alpha.16.4, source tag `rust-v0.155.0-alpha.16.4` (commit `3853cf0c4`) |
| Node | 24.14 |

Re-run the spikes in `spikes/` when any of these change. Both transcript formats change often.

## Answers

### 1. Claude fixtures: captured

Location: `fixtures/claude/2.1.268/`. The captured sessions were: a plain turn, two reads followed by `/compact`, a tool error (missing file), an image `Read`, a Bash call with a non-zero exit, a real 4-way parallel `Edit` window, and two synthetic sessions that resumed successfully. All content is sanitized. The structure is kept as captured: uuids, `parentUuid` links, entry and block types.

Capture notes:

- A temporary `CLAUDE_CONFIG_DIR` is not logged in, because the credentials are tied to the config dir. Captures that need the API therefore ran under the normal config, from a throwaway cwd (`spikes/work1`).
- A temporary config dir still creates the project folder, even though the run then fails with "Not logged in". That makes path-naming tests free.
- `claude -p "/compact" --resume <id>` works headless and writes `system/compact_boundary`, followed by `isCompactSummary` user entries.

Entry types seen in 2.1.268 transcripts: `user`, `assistant`, `attachment`, `system` (`compact_boundary`, `stop_hook_summary`, `local_command`, `bridge_status`), `last-prompt`, `ai-title`, `custom-title`, `queue-operation`, `atis-latch`, `mode`, `bridge-session`, `agent-name`, `file-history-snapshot`, `file-history-delta`, `permission-mode`, `cost-state`.

### 2. Minimum entry set that resumes and passes L3: found

`spikes/minimal.mjs` writes only the following, and it resumes (`fixtures/claude/2.1.268/minimal-*.resumed-ok.jsonl`):

- `user` and `assistant` entries with `parentUuid`, `isSidechain:false`, `uuid`, `timestamp`, `sessionId`, `cwd`, `version`, `userType:"external"`;
- assistant `message` = `{id, type:"message", role, model:"<synthetic>", content:[one block], stop_reason, stop_sequence:null, usage:{zeros}}`;
- `sourceToolAssistantUUID` on tool-result entries;
- one hidden `isMeta:true` header note;
- one `custom-title` entry;
- a trailing newline.

No `attachment`, `last-prompt`, `file-history-snapshot`, `entrypoint`, `gitBranch` or `requestId` entries are needed.

- L3: `getSessionMessages` returns every non-meta message in order, and the `isMeta` header is excluded, so L3 message counts must exclude it. `getSessionInfo` reports `customTitle`, `firstPrompt` and `cwd`, and `listSessions({dir})` lists the session.
- L4: `claude -p --resume <id> --fork-session` on haiku succeeded for both, and the model correctly described the imported history. The source file stayed byte-identical after the fork. The SDK's `deleteSession(id,{dir})` removes a fork cleanly, so use it for journaled L4 cleanup.

**This corrects the plan's L2 invariant "one linear chain".** Parallel tool calls are not linear in 2.1.268. The observed shape is:

```
A(tool_use 1) <- A(tool_use 2) <- A(tool_use 3) <- A(tool_use 4)
R1.parent = A1,  R2.parent = A2,  R3.parent = A3,  R4.parent = A4
next entry.parent = R4 (the last result)
```

That is one user entry per result, each parented to its own tool_use entry. The loader (CLI and SDK) recovers the sibling results. The writer must emit exactly this fan. L2 should check "linear, except parallel fans of this exact shape".

Also confirmed across 16 real transcripts: every assistant entry holds exactly one content block, and entries of one API message share `message.id`.

### 3. Foreign tool names in history: accepted

A resumed history containing `codex_apply_patch` and `mcp__codexfake__lookup` tool_use/tool_result pairs was accepted. Neither tool exists in the resuming session. There was no 400, and the model named both tools in its answer. Native mode can keep foreign tool names without a rename table.

### 4. Folder names over 200 characters: cracked

From SDK `sdk.mjs` (0.3.268), and verified to match the real CLI's folder name exactly (`spikes/work-long`, 245-char sanitized name):

```js
sanitized = path.replace(/[^a-zA-Z0-9]/g, "-")
if (sanitized.length <= 200) return sanitized
h = 0; for (c of path) h = ((h << 5) - h + c.charCodeAt(0)) | 0   // Java-style string hash
return sanitized.slice(0, 200) + "-" + Math.abs(h).toString(36)
```

The input is the real path without a trailing slash (`pwd -P`). No path needs refusing.

### 5. Code tab / desktop card: CLI-only sessions are invisible

The desktop registry is `~/Library/Application Support/Claude/claude-code-sessions/<acct>/<org>/local_*.json`, with ~35 app-private fields (`cliSessionId`, `cwd`, `originCwd`, `gitAnchors`, permission modes, `toolSurfaceSnapshot`, `promptAppendSnapshot`, bridge ids, …). The app's session index and transcript search do not find CLI-written sessions that have no card. `claude --resume` is the supported entry point. Sidebar cards stay opt-in and unbuilt: the shape is too app-private to forge safely.

### 6. Codex Desktop re-offering our files: yes, unless ledgered

Checked at the Codex tag, in `codex-rs/external-agent-migration/src/detect/sessions/{cla,common}.rs` and `sessions/ledger.rs`.

- Codex scans every `~/.claude/projects/*/*.jsonl` whose mtime falls within `max_age`, and requires the recorded `cwd` to exist. There is **no marker-based filter** (`model:"<synthetic>"`, a header note, or a tag are all ignored).
- `summarize_session` in `records_cla.rs` only skips individual `isMeta` / `isSidechain` records.
- The only suppression is a ledger record in `$CODEX_HOME/external_agent_session_imports.json` for that canonical path whose `source_modified_at` (in nanoseconds) equals the file's mtime. Once the user continues in Claude, the mtime changes and Codex offers it again as an append.

Loop prevention therefore means writing a ledger record `{source_path, content_sha256, imported_thread_id: <original Codex thread>, imported_at, source_modified_at}`. That is a write into Codex's folder, so it is deferred to Phase 3, with a backup, and opt-in until then. Phase 1 documents the duplicate-offer behavior.

### 7. Codex rollout fixtures: 10 sanitized rollouts

Location: `fixtures/codex/rollouts/`, selected greedily to cover every feature found (see `manifest.json`). They include paginated and legacy mode, subagent threads, compaction, `turn_aborted`, a truncated or bad line, multiple `session_meta` lines, `world_state`, `inter_agent_communication_metadata`, and every `TurnItem` kind present locally (AgentMessage, Reasoning, UserMessage, CommandExecution, McpToolCall, FileChange, Extension, ContextCompaction, WebSearch, SubAgentActivity, ImageView).

The sanitizer keeps short enum-like values under structural keys (types, ids, statuses, model and tool names). Every other string becomes filler of the same length, capped at 4000 characters. Paths become `/work/p<hash>`, images a 1×1 PNG, encrypted content `ENC:<len>`. Each fixture is capped at 1500 lines.

## Other facts

- The local corpus (counts only, from `spikes/codex-inventory.mjs`) is 232 rollouts, 1.26 GB. 230 are paginated and 2 legacy. 171 are subagent threads and 61 vscode. There are no `.zst` files yet, and 2 unparseable lines (live tails).
- **No rollout drift at the installed tag.** Every line type (`world_state`, `token_usage_record`, `inter_agent_communication_metadata`, …) and every item kind is in `RolloutItem` (`codex-rs/history/src/lib.rs:125`) and `TurnItem` (`codex-rs/protocol/src/items.rs:46`). The earlier "unknown types" came from the stale July checkout. Read source at the tag with `git show "${T}:path"`. In zsh, quote the braces, because `$T:c…` is parsed as a modifier.
- `codex app-server generate-json-schema --out` works (snapshot in `fixtures/codex/schema-0.155.0-alpha.16.4/`). It covers the app-server protocol (v2 thread items), **not** the rollout line format. The rollout drift gate must use tag source plus the unknown-type counts.
- Claude Code **2.1.268 is older than 2.1.275**, the first version that tolerates unknown entry types on resume. So the writer must emit only the entry types listed in answer 2.
