// Codex rollout -> canonical session. Read-only; never throws on unknown shapes.
// Paginated threads (history_mode "paginated"): semantic `event_msg/item_completed` TurnItems are the
// source of truth; turns are bounded by task_started / task_complete / turn_aborted.
// Legacy threads: user_message / agent_message events plus raw call/output response items paired by call_id.
// Types checked against codex tag rust-v0.155.0-alpha.16.4: RolloutItem (codex-rs/history/src/lib.rs:125),
// TurnItem (codex-rs/protocol/src/items.rs:46), SessionMeta.history_base (codex-rs/protocol/src/protocol.rs:3172).
import { fileURLToPath } from "node:url";
import { bump, CANONICAL_VERSION, emptyReport } from "../canonical.ts";
import type { Item, Report, Session, Turn } from "../canonical.ts";
import { readLines } from "./lines.ts";
import type { Line } from "./lines.ts";
import { rolloutFiles } from "./threads.ts";

type J = Record<string, any>;

const KNOWN_LINE_TYPES = new Set([
  "session_meta",
  "response_item",
  "event_msg",
  "turn_context",
  "token_usage_record",
  "world_state",
  "compacted",
  "inter_agent_communication",
  "inter_agent_communication_metadata",
  "security_risk_score",
  "retained_context",
  "realtime_item",
]);

// UI/IDE context Codex Desktop embeds inside the user's text. Split out so it is not rendered as typed input.
const CONTEXT_TAGS = [
  "in-app-browser-context",
  "ide_opened_file",
  "ide_selection",
  "response-annotations",
  "environment_context",
  "user_instructions",
];
const CONTEXT_RE = new RegExp(`<(${CONTEXT_TAGS.join("|")})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`, "g");

type Record_ = { line: Line; d: J; file: string };

async function loadRecords(path: string, limitBytes: number, files: Session["source"]["files"], depth: number, report: Report): Promise<Record_[]> {
  const res = await readLines(path, limitBytes);
  files.unshift({ path, bytesRead: res.bytesRead, sha256: res.sha256 });
  const out: Record_[] = [];
  for (const line of res.lines) {
    report.lines++;
    try {
      out.push({ line, d: JSON.parse(line.text) as J, file: path });
    } catch {
      report.badLines++;
    }
  }
  const meta = out[0]?.d;
  const base = meta?.type === "session_meta" ? meta.payload?.history_base : undefined;
  if (base?.thread_id && depth < 16) {
    const prefixPath = rolloutFiles().get(base.thread_id);
    if (!prefixPath) {
      report.notes.push(`history_base prefix rollout ${base.thread_id} not found; earlier history missing`);
    } else if (prefixPath !== path) {
      const prefix = await loadRecords(prefixPath, base.end_byte_offset, files, depth + 1, report);
      // The prefix's own session_meta describes an ancestor; the child's meta stays canonical.
      return [...prefix.filter((r) => r.d.type !== "session_meta"), ...out];
    }
  }
  return out;
}

// Several TurnItem path fields are PathUri (`file:///…`) at this Codex version (CommandExecutionItem.cwd).
const toPath = (p: unknown): string => {
  if (typeof p !== "string") return "";
  if (!p.startsWith("file://")) return p;
  try {
    return fileURLToPath(p);
  } catch {
    return p;
  }
};
const ms = (r: Record_, p?: J) => p?.completed_at_ms ?? p?.started_at_ms ?? (Date.parse(r.d.timestamp) || 0);
const shellCommand = (argv: string[]) =>
  argv.length === 3 && ["-lc", "-c"].includes(argv[1] ?? "") ? (argv[2] ?? "") : argv.join(" ");

function userItems(at: number, content: J[] | undefined, report: Report): Item[] {
  const out: Item[] = [];
  const texts: string[] = [];
  const images: { path?: string; dataUrl?: string }[] = [];
  for (const b of content ?? []) {
    if (b.type === "text" && typeof b.text === "string") {
      const rest = b.text.replace(CONTEXT_RE, (block: string, tag: string) => {
        out.push({ kind: "context_injection", at, label: tag, text: block });
        return "";
      });
      if (rest.trim()) texts.push(rest.trim());
    } else if (b.type === "local_image" && b.path) images.push({ path: b.path });
    else if (b.type === "image" && b.image_url) images.push({ dataUrl: b.image_url });
    else bump(report.dropped, `user_content:${b.type}`);
  }
  if (texts.length || images.length) out.push({ kind: "user_message", at, text: texts.join("\n\n"), images });
  return out;
}

function turnItem(r: Record_, it: J, at: number, report: Report, pendingCompaction: { summary: string | null }): Item[] {
  switch (it.type) {
    case "UserMessage":
      return userItems(at, it.content, report);
    case "AgentMessage": {
      const text = (it.content ?? []).map((b: J) => b.text ?? "").join("\n");
      return text.trim() ? [{ kind: "agent_message", at, text, final: it.phase === "final_answer" }] : [];
    }
    case "Reasoning": {
      const text = (it.summary_text ?? []).join("\n\n");
      return text.trim() ? [{ kind: "reasoning_summary", at, text }] : [];
    }
    case "CommandExecution":
      return [
        {
          kind: "command",
          at,
          command: shellCommand(it.command ?? []),
          cwd: toPath(it.cwd),
          exitCode: typeof it.exit_code === "number" ? it.exit_code : null,
          output: it.aggregated_output ?? [it.stdout, it.stderr].filter(Boolean).join("\n"),
          ok: it.status === "completed" && (it.exit_code ?? 0) === 0,
        },
      ];
    case "FileChange":
      return [
        {
          kind: "file_change",
          at,
          ok: (it.status ?? "completed") === "completed",
          changes: Object.entries((it.changes ?? {}) as Record<string, J>).map(([path, ch]) => ({
            path: toPath(path),
            op: ch.type === "add" || ch.type === "delete" ? ch.type : "update",
            movePath: ch.move_path ? toPath(ch.move_path) : null,
            diff: ch.unified_diff ?? ch.content ?? "",
          })),
        },
      ];
    case "McpToolCall": {
      const blocks: J[] = it.result?.content ?? [];
      return [
        {
          kind: "mcp_call",
          at,
          server: it.server ?? "",
          tool: it.tool ?? "",
          args: it.arguments ?? null,
          ok: it.status === "completed" && !it.result?.isError,
          resultText: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
          imageCount: blocks.filter((b) => b.type === "image").length,
        },
      ];
    }
    case "WebSearch":
      return [{ kind: "web_search", at, query: it.query ?? it.action?.query ?? "", action: it.action?.type ?? "search" }];
    case "ImageView":
      return [{ kind: "image_view", at, path: toPath(it.path) }];
    case "SubAgentActivity":
      return [{ kind: "subagent", at, threadId: it.agent_thread_id ?? "", label: `${it.kind ?? "activity"} ${it.agent_path ?? ""}`.trim() }];
    case "Extension":
      if (it.kind === "web.search") return [{ kind: "web_search", at, query: it.query ?? it.action?.query ?? "", action: it.action?.type ?? "search" }];
      if (it.kind === "image_gen.generation")
        return [{ kind: "extension", at, name: "image generation", summary: it.status === "completed" || it.savedPath ? "generated an image" : "image generation failed" }];
      if (it.kind === "clock.sleep") return [{ kind: "extension", at, name: "sleep", summary: `waited ${Math.round((it.durationMs ?? 0) / 1000)}s` }];
      return [{ kind: "extension", at, name: String(it.kind ?? "extension"), summary: "" }];
    case "Plan":
      return [{ kind: "extension", at, name: "plan", summary: String(it.text ?? "") }];
    case "ContextCompaction": {
      const summary = pendingCompaction.summary;
      pendingCompaction.summary = null;
      return [{ kind: "compaction", at, summary }];
    }
    default:
      return [{ kind: "unsupported", at, sourceType: String(it.type) }];
  }
}

function readPaginated(records: Record_[], report: Report): Turn[] {
  const turns = new Map<string, Turn>();
  const turnFor = (id: string, at: number) => {
    let t = turns.get(id);
    if (!t) turns.set(id, (t = { id, status: "incomplete", startedAt: at, items: [] }));
    return t;
  };
  const pendingCompaction = { summary: null as string | null };
  for (const r of records) {
    const { d } = r;
    const p: J = d.payload ?? {};
    if (!KNOWN_LINE_TYPES.has(d.type)) {
      bump(report.unknownLineTypes, String(d.type));
      continue;
    }
    if (d.type === "compacted") {
      pendingCompaction.summary = typeof p.message === "string" && p.message.trim() ? p.message : null;
      continue;
    }
    if (d.type !== "event_msg") continue;
    if (p.type === "task_started" && p.turn_id) turnFor(p.turn_id, (p.started_at ?? 0) * 1000 || ms(r));
    else if (p.type === "task_complete" && p.turn_id) turnFor(p.turn_id, ms(r)).status = "completed";
    else if (p.type === "turn_aborted" && p.turn_id) turnFor(p.turn_id, ms(r)).status = "aborted";
    else if (p.type === "item_completed" && p.item) {
      const t = turnFor(p.turn_id ?? "no-turn", ms(r, p));
      t.items.push(...turnItem(r, p.item, ms(r, p), report, pendingCompaction));
    }
  }
  return [...turns.values()];
}

function readLegacy(records: Record_[], report: Report): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  const open = (at: number, id?: string) => {
    cur = { id: id ?? `legacy-${turns.length}`, status: "incomplete", startedAt: at, items: [] };
    turns.push(cur);
    return cur;
  };
  const calls = new Map<string, { turn: Turn; index: number }>();
  for (const r of records) {
    const { d } = r;
    const p: J = d.payload ?? {};
    const at = ms(r);
    if (!KNOWN_LINE_TYPES.has(d.type)) {
      bump(report.unknownLineTypes, String(d.type));
      continue;
    }
    if (d.type === "event_msg") {
      if (p.type === "task_started") open(at, p.turn_id);
      else if (p.type === "task_complete" && cur) (cur as Turn).status = "completed";
      else if (p.type === "turn_aborted" && cur) (cur as Turn).status = "aborted";
      else if (p.type === "user_message") {
        const t: Turn = cur ?? open(at);
        const content: J[] = [{ type: "text", text: p.message ?? "" }, ...(p.images ?? []).map((u: string) => ({ type: "image", image_url: u }))];
        t.items.push(...userItems(at, content, report));
      } else if (p.type === "agent_message" && p.message) (cur ?? open(at)).items.push({ kind: "agent_message", at, text: p.message, final: false });
      else if (p.type === "thread_rolled_back") {
        const n = Number(p.num_turns ?? 0);
        const removed = turns.splice(Math.max(0, turns.length - n), n);
        bump(report.dropped, "rolled_back_turns", removed.length);
        cur = turns.at(-1) ?? null;
      }
    } else if (d.type === "response_item") {
      const t: Turn = cur ?? open(at);
      if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        const name: string = p.name ?? "shell";
        let item: Item;
        if (p.type === "local_shell_call" || ["shell", "exec_command", "local_shell"].includes(name)) {
          let argv: string[] = p.action?.command ?? [];
          try {
            const a = JSON.parse(p.arguments ?? "{}") as J;
            argv = Array.isArray(a.command) ? a.command : typeof a.cmd === "string" ? ["sh", "-c", a.cmd] : argv;
          } catch {}
          item = { kind: "command", at, command: shellCommand(argv), cwd: "", exitCode: null, output: "", ok: false };
        } else item = { kind: "extension", at, name, summary: "" };
        calls.set(p.call_id, { turn: t, index: t.items.push(item) - 1 });
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const call = calls.get(p.call_id);
        if (!call) {
          bump(report.dropped, "output_without_call");
          continue;
        }
        calls.delete(p.call_id);
        const item = call.turn.items[call.index];
        const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
        if (item?.kind === "command") Object.assign(item, { output: out, ok: true });
        else if (item?.kind === "extension") item.summary = out;
      }
    }
  }
  // Calls that never got an output were cut off.
  for (const { turn, index } of calls.values()) {
    const item = turn.items[index];
    if (item?.kind === "command") item.output = "(aborted: no result recorded)";
    else if (item?.kind === "extension") item.summary = "(aborted: no result recorded)";
    bump(report.dropped, "call_without_output_marked_aborted");
  }
  return turns;
}

export async function readCodexThread(rolloutPath: string): Promise<{ session: Session; report: Report }> {
  const report = emptyReport();
  const files: Session["source"]["files"] = [];
  const records = await loadRecords(rolloutPath, Infinity, files, 0, report);
  const meta = records.find((r) => r.d.type === "session_meta" && r.file === rolloutPath)?.d.payload ?? {};
  const model =
    [...records].reverse().find((r) => r.d.type === "turn_context")?.d.payload?.model ?? meta.base_instructions?.provenance?.model ?? null;
  const paginated = meta.history_mode === "paginated";
  const turns = (paginated ? readPaginated(records, report) : readLegacy(records, report)).filter((t) => t.items.length);
  for (const t of turns) for (const it of t.items) bump(report.items, it.kind);
  const session: Session = {
    canonicalVersion: CANONICAL_VERSION,
    source: {
      agent: "codex",
      threadId: meta.id ?? "",
      title: null,
      cwd: meta.cwd ?? "",
      gitBranch: meta.git?.branch ?? null,
      model,
      cliVersion: meta.cli_version ?? "",
      createdAt: Date.parse(meta.timestamp) || 0,
      files,
    },
    turns,
  };
  return { session, report };
}
