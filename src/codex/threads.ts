// Codex thread discovery. Read-only.
// Primary index: $CODEX_HOME/state_*.sqlite `threads` (Codex itself prefers it to pick a thread's
// current rollout file, e.g. after a revert: codex-rs/rollout/src/list.rs find_thread_path_by_id_str_in_subdir).
// Fallback: filename scan + first-line session_meta.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { codexHome } from "../env.ts";
import { readLines } from "./lines.ts";

export type ThreadKind = "native" | "subagent" | "claude-import";
export type CodexThread = {
  id: string;
  rolloutPath: string;
  kind: ThreadKind;
  title: string | null;
  cwd: string;
  archived: boolean;
  updatedAt: number;
};

// rollout-<ts>-<threadId>[_<rolloutId>].jsonl[.zst]; no suffix means rolloutId == threadId
// (codex-rs/rollout/src/rollout_file_name.rs RolloutFileName::parse).
const ROLLOUT_RE = /^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl(\.zst)?$/;

export function rolloutFiles(home = codexHome()): Map<string, string> {
  // rollout id (from the filename) -> path; history_base.thread_id refers to this id.
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = ROLLOUT_RE.exec(e.name);
        const rolloutId = m?.[2] ?? m?.[1];
        // Prefer the plain file when both exist mid-compression.
        if (rolloutId && (!out.has(rolloutId) || !p.endsWith(".zst"))) out.set(rolloutId, p);
      }
    }
  };
  walk(join(home, "sessions"));
  walk(join(home, "archived_sessions"));
  return out;
}

export function existingRollout(path: string): string | null {
  if (existsSync(path)) return path;
  if (existsSync(`${path}.zst`)) return `${path}.zst`;
  return null;
}

function sessionIndexTitles(home: string): Map<string, string> {
  const titles = new Map<string, { name: string; at: string }>();
  let text = "";
  try {
    text = readFileSync(join(home, "session_index.jsonl"), "utf8");
  } catch {
    return new Map();
  }
  for (const line of text.split("\n")) {
    try {
      const d = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string };
      if (!d.id || !d.thread_name) continue;
      const prev = titles.get(d.id);
      if (!prev || (d.updated_at ?? "") >= prev.at) titles.set(d.id, { name: d.thread_name, at: d.updated_at ?? "" });
    } catch {}
  }
  return new Map([...titles].map(([id, v]) => [id, v.name]));
}

// Threads Codex created by importing Claude sessions; converting them back would loop.
export function claudeImportedThreadIds(home = codexHome()): Set<string> {
  try {
    const led = JSON.parse(readFileSync(join(home, "external_agent_session_imports.json"), "utf8")) as {
      records?: { imported_thread_id?: string }[];
    };
    return new Set((led.records ?? []).map((r) => r.imported_thread_id).filter((x): x is string => Boolean(x)));
  } catch {
    return new Set();
  }
}

function stateDb(home: string): string | null {
  const dbs = readdirSync(home)
    .filter((f) => /^state_\d+\.sqlite$/.test(f))
    .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
  return dbs[0] ? join(home, dbs[0]) : null;
}

type Row = {
  id: string;
  rollout_path: string;
  source: string;
  cwd: string;
  title: string;
  name: string | null;
  archived: number;
  updated_at_ms: number | null;
  updated_at: number;
};

export async function listThreads(home = codexHome()): Promise<CodexThread[]> {
  const titles = sessionIndexTitles(home);
  const imported = claudeImportedThreadIds(home);
  const kindOf = (id: string, source: string): ThreadKind =>
    source.includes("subagent") ? "subagent" : imported.has(id) ? "claude-import" : "native";
  const dbPath = existsSync(home) ? stateDb(home) : null;
  if (dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("select id, rollout_path, source, cwd, title, name, archived, updated_at_ms, updated_at from threads")
        .all() as unknown as Row[];
      const out: CodexThread[] = [];
      for (const r of rows) {
        const path = existingRollout(r.rollout_path);
        if (!path) continue;
        out.push({
          id: r.id,
          rolloutPath: path,
          kind: kindOf(r.id, r.source),
          title: titles.get(r.id) ?? r.name ?? (r.title || null),
          cwd: r.cwd,
          archived: r.archived === 1,
          updatedAt: r.updated_at_ms ?? r.updated_at * 1000,
        });
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    } finally {
      db.close();
    }
  }
  // Fallback without the state DB: one rollout file per thread id, newest mtime wins.
  const byThread = new Map<string, CodexThread>();
  for (const path of rolloutFiles(home).values()) {
    const { lines } = await readLines(path, 4 * 1024 * 1024);
    const first = lines[0];
    if (!first) continue;
    let meta;
    try {
      meta = JSON.parse(first.text) as { type?: string; payload?: { id?: string; cwd?: string; source?: unknown } };
    } catch {
      continue;
    }
    const p = meta.payload;
    if (meta.type !== "session_meta" || !p?.id) continue;
    const updatedAt = statSync(path).mtimeMs;
    const prev = byThread.get(p.id);
    if (prev && prev.updatedAt >= updatedAt) continue;
    byThread.set(p.id, {
      id: p.id,
      rolloutPath: path,
      kind: kindOf(p.id, JSON.stringify(p.source ?? "")),
      title: titles.get(p.id) ?? null,
      cwd: p.cwd ?? "",
      archived: path.includes("/archived_sessions/"),
      updatedAt,
    });
  }
  return [...byThread.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
