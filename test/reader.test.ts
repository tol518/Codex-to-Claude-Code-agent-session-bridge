import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../src/canonical.ts";
import { readLines } from "../src/codex/lines.ts";
import { readCodexThread } from "../src/codex/reader.ts";
import { agent, command, makeEnv, Rollout } from "./helpers.ts";
import type { TestEnv } from "./helpers.ts";

const FIXTURES = new URL("../fixtures/codex/rollouts/", import.meta.url).pathname;
let env: TestEnv;
beforeEach(() => (env = makeEnv()));
afterEach(() => env.cleanup());

describe("readLines", () => {
  it("stops at the last complete newline and hashes exactly the consumed bytes", async () => {
    const p = join(env.root, "live.jsonl");
    writeFileSync(p, '{"a":1}\n{"b":2}\n{"c":');
    const r = await readLines(p);
    expect(r.lines.map((l) => l.text)).toEqual(['{"a":1}', '{"b":2}']);
    expect(r.bytesRead).toBe(16);
    expect(r.lines[1]?.offset).toBe(8);
    const { createHash } = await import("node:crypto");
    expect(r.sha256).toBe(createHash("sha256").update('{"a":1}\n{"b":2}\n').digest("hex"));
  });

  it("honors a byte limit only at line boundaries", async () => {
    const p = join(env.root, "x.jsonl");
    writeFileSync(p, "one\ntwo\nthree\n");
    expect((await readLines(p, 8)).lines.map((l) => l.text)).toEqual(["one", "two"]);
    expect((await readLines(p, 7)).lines.map((l) => l.text)).toEqual(["one"]);
  });
});

describe("sanitized real fixtures", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"));
  it.each(files)("%s parses into a valid canonical session with no unknown line types", async (f) => {
    const { session, report } = await readCodexThread(join(FIXTURES, f));
    expect(() => Session.parse(session)).not.toThrow();
    expect(report.unknownLineTypes).toEqual({});
  });

  it("maps every TurnItem kind present in the fixtures", async () => {
    const kinds = new Set<string>();
    for (const f of files) for (const [k, n] of Object.entries((await readCodexThread(join(FIXTURES, f))).report.items)) if (n) kinds.add(k);
    for (const k of ["user_message", "agent_message", "command", "file_change", "mcp_call", "web_search", "image_view", "subagent", "compaction", "extension"]) expect(kinds).toContain(k);
    expect(kinds).not.toContain("unsupported");
  });
});

describe("paginated reader", () => {
  it("groups items by turn, keeps statuses, unwraps shell -lc and splits UI context out of user text", async () => {
    const r = new Rollout("11111111-1111-7111-8111-111111111111", env.work);
    r.turn("t1", "fix the login bug", (x) => {
      x.item("t1", command("rg -n login src"));
      x.item("t1", agent("found it", "commentary"));
      x.item("t1", { type: "FileChange", id: "fc", changes: { [join(env.work, "src/login.ts")]: { type: "update", unified_diff: "@@\n-a\n+b\n", move_path: null } }, status: "completed" });
      x.item("t1", agent("fixed"));
    });
    r.event({ type: "task_started", turn_id: "t2", started_at: 1 });
    r.item("t2", { type: "UserMessage", id: "u2", content: [{ type: "text", text: "<ide_selection>secret selection</ide_selection>\nnow add a test" }, { type: "local_image", path: "/tmp/shot.png" }] });
    r.event({ type: "turn_aborted", turn_id: "t2", reason: "interrupted" });
    r.push("world_state", { full: false, state: {} }).push("brand_new_line_type", {});
    const { session, report } = await readCodexThread(r.write(env.codex));
    expect(session.turns.map((t) => t.status)).toEqual(["completed", "aborted"]);
    const [t1, t2] = session.turns;
    expect(t1?.items.map((i) => i.kind)).toEqual(["user_message", "command", "agent_message", "file_change", "agent_message"]);
    expect(t1?.items[1]).toMatchObject({ kind: "command", command: "rg -n login src", cwd: "/work/repo", ok: true });
    expect(t2?.items).toMatchObject([
      { kind: "context_injection", label: "ide_selection" },
      { kind: "user_message", text: "now add a test", images: [{ path: "/tmp/shot.png" }] },
    ]);
    expect(report.unknownLineTypes).toEqual({ brand_new_line_type: 1 });
    expect(session.source).toMatchObject({ threadId: r.threadId, cwd: env.work, gitBranch: "main", cliVersion: "0.155.0-alpha.16.4" });
  });

  it("follows history_base prefix files named <thread>_<rollout>, cutting at end_byte_offset", async () => {
    const thread = "22222222-2222-7222-8222-222222222222";
    const oldRollout = "33333333-3333-7333-8333-333333333333";
    const prefix = new Rollout(thread, env.work);
    prefix.turn("t1", "first question", (x) => x.item("t1", agent("first answer")));
    const cut = Buffer.byteLength(prefix.text());
    prefix.turn("t-reverted", "reverted question", (x) => x.item("t-reverted", agent("reverted answer")));
    prefix.write(env.codex, oldRollout);
    const child = new Rollout(thread, env.work, { history_base: { thread_id: oldRollout, end_ordinal_exclusive: 99, end_byte_offset: cut } });
    child.turn("t3", "second question", (x) => x.item("t3", agent("second answer")));
    const childPath = child.write(env.codex, "44444444-4444-7444-8444-444444444444");
    const { session } = await readCodexThread(childPath);
    expect(session.turns.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(session.source.files).toHaveLength(2);
    expect(session.source.files[0]?.bytesRead).toBe(cut);
  });

  it("keeps reading when the last line is truncated or a line is corrupt", async () => {
    const r = new Rollout("55555555-5555-7555-8555-555555555555", env.work);
    r.turn("t1", "hello", (x) => x.item("t1", agent("hi")));
    const p = r.write(env.codex);
    writeFileSync(p, readFileSync(p, "utf8").replace('"hello"', '"hello"').split("\n").toSpliced(2, 0, "{not json").join("\n") + '{"timestamp":"2026');
    const { session, report } = await readCodexThread(p);
    expect(report.badLines).toBe(1);
    expect(session.turns[0]?.items.map((i) => i.kind)).toEqual(["user_message", "agent_message"]);
  });
});

describe("legacy reader", () => {
  it("pairs calls with outputs by call_id, marks unanswered calls aborted, drops orphan outputs, applies rollback", async () => {
    const id = "66666666-6666-7666-8666-666666666666";
    const lines = [
      { type: "session_meta", payload: { id, cwd: env.work, cli_version: "0.100.0", timestamp: "2026-01-01T00:00:00Z" } },
      { type: "event_msg", payload: { type: "user_message", message: "run two things" } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "ls"] }), call_id: "a" } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "pwd"] }), call_id: "b" } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "sleep 99"] }), call_id: "c" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "b", output: "/repo" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "a", output: "file.txt" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "zzz", output: "orphan" } },
      { type: "event_msg", payload: { type: "agent_message", message: "done" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "event_msg", payload: { type: "user_message", message: "undo me" } },
      { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
    ].map((l, i) => ({ timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), ...l }));
    const p = join(env.codex, "legacy.jsonl");
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const { session, report } = await readCodexThread(p);
    expect(session.turns).toHaveLength(1);
    const cmds = session.turns[0]!.items.filter((i) => i.kind === "command");
    expect(cmds.map((c) => [c.command, c.output])).toEqual([
      ["ls", "file.txt"],
      ["pwd", "/repo"],
      ["sleep 99", "(aborted: no result recorded)"],
    ]);
    expect(report.dropped).toMatchObject({ output_without_call: 1, call_without_output_marked_aborted: 1, rolled_back_turns: 1 });
  });
});
