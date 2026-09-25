// Canonical session -> Claude Code transcript entries, "transcript" render mode.
// No tool_use blocks at all: Codex tool calls become compact capped "▸" lines inside assistant text,
// so tool call/result pairing can never break a resume. Output is deterministic for a given input.
import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { Item, Session } from "../canonical.ts";
import type { AssistantEntry, Entry, UserEntry } from "./schema.ts";

export const RENDERER_VERSION = "transcript-1";

export type RenderOptions = {
  sessionId: string;
  claudeVersion: string;
  cwd: string; // real path used for the project folder
  importedAt: Date;
  includeReasoning?: boolean;
};

export type Rendered = { entries: Entry[]; jsonl: string; approxTokens: number; conversation: { role: "user" | "assistant"; text: string }[] };

// RFC 4122 v5-style uuid from a stable name, so a re-render yields identical bytes.
export function stableUuid(name: string): string {
  const h = createHash("sha1").update("agent-session-bridge:").update(name).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const lastLine = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";

function toolLines(it: Item, cwd: string): string[] {
  const rel = (p: string) => {
    if (!isAbsolute(p)) return p;
    const r = relative(cwd, p);
    return r && !r.startsWith("..") ? r : p;
  };
  switch (it.kind) {
    case "command": {
      const where = it.cwd && it.cwd !== cwd ? ` in ${rel(it.cwd)}` : "";
      const result = it.ok ? "exit 0" : it.exitCode !== null ? `exit ${it.exitCode}` : "failed";
      const tail = it.ok ? "" : lastLine(it.output) && ` · ${oneLine(lastLine(it.output), 100)}`;
      return [`▸ ran \`${oneLine(it.command, 160)}\`${where} → ${result}${tail}`];
    }
    case "file_change":
      return it.changes.map((c) => {
        const lines = c.diff.split("\n");
        const add = c.op === "add" ? lines.length : lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const del = c.op === "delete" ? lines.length : lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        const verb = c.op === "add" ? "created" : c.op === "delete" ? "deleted" : c.movePath ? `moved to ${rel(c.movePath)} and edited` : "edited";
        return `▸ ${verb} ${rel(c.path)} (+${add} −${del})${it.ok ? "" : " (failed)"}`;
      });
    case "mcp_call":
      return [`▸ called ${it.server}.${it.tool} → ${it.ok ? "ok" : "error"}${it.imageCount ? ` (${it.imageCount} image${it.imageCount > 1 ? "s" : ""})` : ""}`];
    case "web_search":
      return [it.action === "search" ? `▸ searched the web: "${oneLine(it.query, 120)}"` : `▸ web ${it.action.replace(/_/g, " ")}${it.query ? `: ${oneLine(it.query, 120)}` : ""}`];
    case "image_view":
      return [`▸ viewed image ${rel(it.path)}`];
    case "subagent":
      return [`▸ subagent ${oneLine(it.label, 120)}`];
    case "extension":
      return [`▸ ${it.name}${it.summary ? `: ${oneLine(it.summary, 120)}` : ""}`];
    case "compaction":
      return [it.summary ? `▸ Codex compacted its context here. Summary: ${oneLine(it.summary, 2000)}` : "▸ Codex compacted its context here (summary not readable)."];
    case "unsupported":
      return [`▸ [Codex ${it.sourceType} item not converted]`];
    default:
      return [];
  }
}

export function renderTranscript(session: Session, opts: RenderOptions): Rendered {
  const { sessionId } = opts;
  const entries: Entry[] = [];
  const conversation: Rendered["conversation"] = [];
  let parent: string | null = null;
  let lastTs = 0;
  let n = 0;
  const stamp = (at: number) => new Date((lastTs = Math.max(lastTs, at || lastTs))).toISOString();
  const base = (at: number) => {
    const uuid = stableUuid(`${sessionId}:${n++}`);
    const b = { parentUuid: parent, isSidechain: false as const, uuid, timestamp: stamp(at), sessionId, cwd: opts.cwd, version: opts.claudeVersion, userType: "external" as const };
    parent = uuid;
    return b;
  };
  const user = (at: number, content: string, meta = false) => {
    const e: UserEntry = { ...base(at), type: "user", ...(meta ? { isMeta: true as const } : {}), message: { role: "user", content } };
    entries.push(e);
    if (!meta) conversation.push({ role: "user", text: content });
  };
  const assistant = (at: number, text: string) => {
    const b = base(at);
    const e: AssistantEntry = {
      ...b,
      type: "assistant",
      message: {
        id: `msg_asb_${b.uuid.replaceAll("-", "")}`,
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    };
    entries.push(e);
    conversation.push({ role: "assistant", text });
  };

  const src = session.source;
  const title = src.title ?? "untitled";
  const firstAt = session.turns[0]?.startedAt ?? src.createdAt;
  user(
    firstAt,
    [
      `Imported from Codex thread ${src.threadId} ("${title}") on ${opts.importedAt.toISOString().slice(0, 10)} by agent-session-bridge.`,
      `The conversation below happened in Codex${src.model ? ` (model ${src.model})` : ""}, working in ${src.cwd || opts.cwd}.`,
      `Lines starting with ▸ summarize tool calls that Codex ran; they are real history, not calls you made, and their full output was not carried over.`,
    ].join("\n"),
    true,
  );

  for (const turn of session.turns) {
    let pieces: string[] = [];
    let tools: string[] = [];
    let at = turn.startedAt;
    let userSeen = false;
    let replied = false;
    const flush = () => {
      if (tools.length) pieces.push(tools.join("\n"));
      tools = [];
      if (pieces.length) {
        assistant(at, pieces.join("\n\n"));
        replied = true;
      }
      pieces = [];
    };
    for (const it of turn.items) {
      at = it.at || at;
      if (it.kind === "user_message") {
        flush();
        if (userSeen && !replied) assistant(at, "(Codex recorded no reply before this message.)");
        const images = it.images.map((im) => `[image attached in Codex${im.path ? `: ${im.path.split("/").pop()}` : ""}]`);
        user(at, [it.text, ...images].filter(Boolean).join("\n") || "(empty message)");
        userSeen = true;
        replied = false;
      } else if (it.kind === "agent_message") {
        // The API rejects empty text blocks, so whitespace-only messages are skipped.
        if (!it.text.trim()) continue;
        if (tools.length) pieces.push(tools.join("\n"));
        tools = [];
        pieces.push(it.text.trim());
      } else if (it.kind === "reasoning_summary") {
        if (opts.includeReasoning && it.text.trim()) pieces.push(`(Codex reasoning summary) ${it.text.trim()}`);
      } else if (it.kind !== "context_injection") tools.push(...toolLines(it, src.cwd || opts.cwd));
    }
    if (turn.status === "aborted") tools.push("▸ (the Codex turn was interrupted here)");
    flush();
    if (userSeen && !replied) assistant(at, "(Codex recorded no reply.)");
  }
  entries.push({ type: "custom-title", customTitle: `[Codex] ${title}`, sessionId });

  const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return { entries, jsonl, approxTokens: Math.round(conversation.reduce((s, m) => s + m.text.length, 0) / 4), conversation };
}
