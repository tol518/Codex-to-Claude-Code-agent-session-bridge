// Validation ladder for written Claude transcripts (L1 schema, L2 invariants, L3 official read-back).
// An import only counts as done when all three pass.
import { createHash } from "node:crypto";
import { getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { Entry } from "./claude/schema.ts";
import type { Rendered } from "./claude/transcript.ts";
import { sessionFilesById } from "./claude/project.ts";

export type Check = { level: "L1" | "L2" | "L3"; ok: boolean; problems: string[] };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function l1(jsonl: string): Check {
  const problems: string[] = [];
  jsonl
    .split("\n")
    .filter(Boolean)
    .forEach((line, i) => {
      const r = Entry.safeParse(JSON.parse(line));
      if (!r.success) problems.push(`line ${i + 1}: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
    });
  return { level: "L1", ok: !problems.length, problems };
}

// Each rule here is a bug seen in an existing converter (plan §8).
export function l2(jsonl: string, sessionId: string): Check {
  const problems: string[] = [];
  if (!jsonl.endsWith("\n")) problems.push("missing trailing newline");
  if (jsonl.includes("\n\n")) problems.push("blank line");
  const entries = jsonl.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  const chain = entries.filter((e) => typeof e.uuid === "string");
  const seen = new Set<string>();
  let prev: string | null = null;
  let prevTs = "";
  chain.forEach((e, i) => {
    if (seen.has(e.uuid)) problems.push(`duplicate uuid at ${i}`);
    seen.add(e.uuid);
    if (e.parentUuid !== prev) problems.push(`entry ${i} parent is not the previous entry (transcript mode is linear)`);
    if (e.sessionId !== sessionId) problems.push(`entry ${i} has foreign sessionId`);
    if (e.timestamp < prevTs) problems.push(`entry ${i} timestamp goes backwards`);
    prev = e.uuid;
    prevTs = e.timestamp;
  });
  if (chain.filter((e) => e.parentUuid === null).length !== 1) problems.push("transcript must have exactly one root");
  if (!(chain[0]?.type === "user" && chain[0]?.isMeta === true)) problems.push("first entry must be the hidden import header");
  const raw = JSON.stringify(entries);
  for (const bad of ['"thinking"', '"redacted_thinking"', '"tool_use"', '"tool_result"', '"signature"'])
    if (raw.includes(`"type":${bad}`) || raw.includes(`${bad}:`)) problems.push(`forbidden block ${bad}`);
  const titles = entries.filter((e) => e.type === "custom-title");
  if (titles.length !== 1 || entries.at(-1)?.type !== "custom-title") problems.push("expected exactly one trailing custom-title entry");
  if (sessionFilesById(sessionId).length > 1) problems.push("session id exists in more than one project folder");
  return { level: "L2", ok: !problems.length, problems };
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).join("")
      : "";

// L3: what Claude Code's own loader (via the pinned Agent SDK) sees must equal what we wrote.
export async function l3(sessionId: string, cwd: string, rendered: Rendered, title: string): Promise<Check> {
  const problems: string[] = [];
  const msgs = await getSessionMessages(sessionId, { dir: cwd });
  if (msgs.length !== rendered.conversation.length) problems.push(`SDK sees ${msgs.length} messages, wrote ${rendered.conversation.length}`);
  msgs.forEach((m, i) => {
    const want = rendered.conversation[i];
    if (!want) return;
    if (m.type !== want.role) problems.push(`message ${i}: role ${m.type} != ${want.role}`);
    else if (sha(textOf((m.message as { content?: unknown })?.content)) !== sha(want.text)) problems.push(`message ${i}: content hash differs`);
  });
  const info = await getSessionInfo(sessionId, { dir: cwd });
  if (!info) problems.push("getSessionInfo found no session");
  else {
    if (info.customTitle !== title) problems.push("title not visible to SDK");
    if (info.cwd !== cwd) problems.push(`SDK cwd ${info.cwd} != ${cwd}`);
  }
  return { level: "L3", ok: !problems.length, problems: problems.slice(0, 20) };
}
