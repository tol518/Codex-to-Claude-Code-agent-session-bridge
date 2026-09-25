// Phase 0 spike: smallest hand-written transcript that Claude Code 2.1.268 loads and resumes.
// Usage: node spikes/minimal.mjs <variant> <cwd>   -> prints session id
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [variant = "text", cwd = process.cwd()] = process.argv.slice(2);
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const sanitize = (p) => {
  const s = p.replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= 200) return s;
  let h = 0;
  for (let i = 0; i < p.length; i++) h = ((h << 5) - h + p.charCodeAt(i)) | 0;
  return `${s.slice(0, 200)}-${Math.abs(h).toString(36)}`;
};

const sessionId = randomUUID();
let parent = null;
let clock = Date.parse("2026-09-01T10:00:00Z");
const entries = [];
const base = () => ({
  parentUuid: parent,
  isSidechain: false,
  uuid: randomUUID(),
  timestamp: new Date((clock += 1000)).toISOString(),
  sessionId,
  cwd,
  version: "2.1.268",
  userType: "external",
});
const push = (e) => {
  entries.push(e);
  if (e.uuid) parent = e.uuid;
  return e;
};
const user = (content, extra = {}) =>
  push({ ...base(), type: "user", message: { role: "user", content }, ...extra });
const assistant = (block, msgId, stop) =>
  push({
    ...base(),
    type: "assistant",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [block],
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });
const msgId = () => `msg_bridge_${randomUUID().replaceAll("-", "")}`;

user(
  "Imported from Codex thread 019-spike on 2026-09-01. The tool calls below were run by Codex, not by you; treat their results as real history.",
  { isMeta: true },
);
user("Which file should I look at for the login bug? It's in src/auth/login.ts I think.");

if (variant === "text") {
  assistant(
    { type: "text", text: "▸ ran `rg -n login src/auth` → exit 0\n\nThe bug is in src/auth/login.ts: the token expiry check uses `<` instead of `<=`." },
    msgId(),
    "end_turn",
  );
} else {
  const m1 = msgId();
  const a = assistant({ type: "text", text: "Let me look." }, m1, "tool_use");
  const t1 = assistant(
    { type: "tool_use", id: "toolu_bridge_0001", name: "Bash", input: { command: "rg -n login src/auth", description: "Search auth code" } },
    m1,
    "tool_use",
  );
  const t2 = assistant(
    { type: "tool_use", id: "toolu_bridge_0002", name: "codex_apply_patch", input: { patch: "*** Begin Patch\n*** Update File: src/auth/login.ts\n-if (exp < now)\n+if (exp <= now)\n*** End Patch" } },
    m1,
    "tool_use",
  );
  // Parallel calls: CLI 2.1.268 writes one user entry per result, each parented to its own
  // tool_use entry (a fan, not a line); the next entry hangs off the last result.
  parent = t1.uuid;
  user([{ type: "tool_result", tool_use_id: "toolu_bridge_0001", content: "src/auth/login.ts:42: if (exp < now) {" }], {
    sourceToolAssistantUUID: t1.uuid,
  });
  parent = t2.uuid;
  user([{ type: "tool_result", tool_use_id: "toolu_bridge_0002", content: "Success. Updated src/auth/login.ts" }], {
    sourceToolAssistantUUID: t2.uuid,
  });
  const m2 = msgId();
  const t3 = assistant(
    { type: "tool_use", id: "toolu_bridge_0003", name: "mcp__codexfake__lookup", input: { q: "expiry" } },
    m2,
    "tool_use",
  );
  user([{ type: "tool_result", tool_use_id: "toolu_bridge_0003", content: [{ type: "text", text: "expiry docs: inclusive" }] }], {
    sourceToolAssistantUUID: t3.uuid,
  });
  assistant({ type: "text", text: "Fixed: src/auth/login.ts line 42 now uses `<=`." }, msgId(), "end_turn");
  void a;
}
entries.push({ type: "custom-title", customTitle: `[Codex] spike ${variant}`, sessionId });

const dir = join(configDir, "projects", sanitize(cwd));
mkdirSync(dir, { recursive: true });
const file = join(dir, `${sessionId}.jsonl`);
if (existsSync(file)) throw new Error("exists");
writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", { flag: "wx" });
console.log(sessionId);
