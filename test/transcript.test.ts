import { describe, expect, it } from "vitest";
import type { Item, Session } from "../src/canonical.ts";
import { sanitizeProjectPath } from "../src/claude/project.ts";
import { renderTranscript, stableUuid } from "../src/claude/transcript.ts";
import { l1, l2 } from "../src/validate.ts";

const opts = { sessionId: stableUuid("t"), claudeVersion: "2.1.268", cwd: "/work/repo", importedAt: new Date("2026-09-25T00:00:00Z") };
const session = (turns: Session["turns"]): Session => ({
  canonicalVersion: 1,
  source: { agent: "codex", threadId: "thread-1", title: "Fix login", cwd: "/work/repo", gitBranch: null, model: "gpt-5.5", cliVersion: "x", createdAt: 0, files: [] },
  turns,
});

// Seeded generator so property failures are reproducible.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}
function randomItem(r: () => number, at: number): Item {
  const s = () => ["", " ", "x", "multi\nline", "<b>tag</b>", "ümlaut ✓", "a".repeat(500)][Math.floor(r() * 7)]!;
  switch (Math.floor(r() * 11)) {
    case 0: return { kind: "user_message", at, text: s(), images: r() > 0.7 ? [{ path: "/a/b.png" }] : [] };
    case 1: return { kind: "agent_message", at, text: s(), final: r() > 0.5 };
    case 2: return { kind: "command", at, command: s(), cwd: r() > 0.5 ? "/work/repo" : "/elsewhere", exitCode: r() > 0.5 ? 0 : 2, output: s(), ok: r() > 0.5 };
    case 3: return { kind: "file_change", at, ok: r() > 0.3, changes: [{ path: "/work/repo/f.ts", op: (["add", "update", "delete"] as const)[Math.floor(r() * 3)]!, movePath: null, diff: s() }] };
    case 4: return { kind: "mcp_call", at, server: "s", tool: "t", args: {}, ok: r() > 0.5, resultText: s(), imageCount: Math.floor(r() * 3) };
    case 5: return { kind: "web_search", at, query: s(), action: r() > 0.5 ? "search" : "open_page" };
    case 6: return { kind: "compaction", at, summary: r() > 0.5 ? s() || null : null };
    case 7: return { kind: "context_injection", at, label: "ide_selection", text: s() };
    case 8: return { kind: "reasoning_summary", at, text: s() };
    case 9: return { kind: "subagent", at, threadId: "x", label: s() };
    default: return { kind: "unsupported", at, sourceType: "HookPrompt" };
  }
}

describe("transcript renderer", () => {
  it("property: any canonical session renders to entries that pass L1 and L2", () => {
    const r = rng(42);
    for (let i = 0; i < 300; i++) {
      const turns = Array.from({ length: Math.floor(r() * 5) }, (_, t) => ({
        id: `t${t}`,
        status: (["completed", "aborted", "incomplete"] as const)[Math.floor(r() * 3)]!,
        startedAt: 1_700_000_000_000 + t * 1000 - Math.floor(r() * 5000), // includes out-of-order clocks
        items: Array.from({ length: Math.floor(r() * 8) }, (_, k) => randomItem(r, 1_700_000_000_000 + t * 1000 + k)),
      }));
      const out = renderTranscript(session(turns), { ...opts, includeReasoning: r() > 0.5 });
      const c1 = l1(out.jsonl);
      const c2 = l2(out.jsonl, opts.sessionId);
      expect(c1.problems, `case ${i}`).toEqual([]);
      expect(c2.problems, `case ${i}`).toEqual([]);
    }
  });

  it("is deterministic and never emits tool_use or thinking blocks", () => {
    const s = session([{ id: "t", status: "completed", startedAt: 1, items: [{ kind: "user_message", at: 1, text: "hi", images: [] }, { kind: "command", at: 2, command: "ls", cwd: "/work/repo", exitCode: 0, output: "", ok: true }, { kind: "agent_message", at: 3, text: "done", final: true }] }]);
    const a = renderTranscript(s, opts);
    expect(renderTranscript(s, opts).jsonl).toBe(a.jsonl);
    expect(a.jsonl).not.toMatch(/"tool_use"|"thinking"/);
    expect(a.conversation).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "▸ ran `ls` → exit 0\n\ndone" },
    ]);
    expect(a.entries[0]).toMatchObject({ type: "user", isMeta: true, parentUuid: null });
    expect(a.entries.at(-1)).toEqual({ type: "custom-title", customTitle: "[Codex] Fix login", sessionId: opts.sessionId });
  });

  it("shows interrupted turns and turns without a reply", () => {
    const s = session([
      { id: "a", status: "aborted", startedAt: 1, items: [{ kind: "user_message", at: 1, text: "q1", images: [] }] },
      { id: "b", status: "completed", startedAt: 2, items: [{ kind: "user_message", at: 2, text: "q2", images: [] }, { kind: "user_message", at: 3, text: "q3", images: [] }, { kind: "agent_message", at: 4, text: "a3", final: true }] },
    ]);
    expect(renderTranscript(s, opts).conversation.map((m) => m.text)).toEqual(["q1", "▸ (the Codex turn was interrupted here)", "q2", "(Codex recorded no reply before this message.)", "q3", "a3"]);
  });
});

describe("project folder naming", () => {
  it("matches the name CLI 2.1.268 created for a >200-char path (COMPAT.md §4)", () => {
    const p = `/private/tmp/asb-long-check/${Array.from({ length: 14 }, (_, i) => `segment-${String(i + 1).padStart(2, "0")}-abcdefghij`).join("/")}`;
    expect(sanitizeProjectPath(p)).toBe(
      "-private-tmp-asb-long-check-segment-01-abcdefghij-segment-02-abcdefghij-segment-03-abcdefghij-segment-04-abcdefghij-segment-05-abcdefghij-segment-06-abcdefghij-segment-07-abcdefghij-segment-08-abcdefg-jj3j3h",
    );
    expect(sanitizeProjectPath("/Users/a.b/my_repo")).toBe("-Users-a-b-my-repo");
  });
});
