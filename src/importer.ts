// Codex -> Claude import orchestration: read, render, validate, write add-only, verify, commit.
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_VERSION } from "./canonical.ts";
import type { Report } from "./canonical.ts";
import { readCodexThread } from "./codex/reader.ts";
import type { CodexThread } from "./codex/threads.ts";
import { codexHome } from "./env.ts";
import { isSessionLive, projectDirFor, sessionFilesById } from "./claude/project.ts";
import { renderTranscript, RENDERER_VERSION, stableUuid } from "./claude/transcript.ts";
import { createExclusive, deleteIfOurs, fileSha, newOpId, sha256, tempPathFor } from "./safety.ts";
import type { Store } from "./store.ts";
import { l1, l2, l3 } from "./validate.ts";
import type { Check } from "./validate.ts";

export const MODE = "transcript";
export const CONVERTER = `canonical-${CANONICAL_VERSION}/${RENDERER_VERSION}`;
// Claude Code versions whose transcript shape the fixtures prove (COMPAT.md). Others get a warning:
// transcript mode only writes the minimal entry set, which older and newer CLIs both load.
export const VERIFIED_CLAUDE_VERSIONS = ["2.1.268"];

export function claudeVersion(): string {
  if (process.env.ASB_CLAUDE_VERSION) return process.env.ASB_CLAUDE_VERSION;
  const out = execFileSync("claude", ["--version"], { encoding: "utf8" });
  const v = /\d+\.\d+\.\d+/.exec(out)?.[0];
  if (!v) throw new Error(`cannot parse claude --version output`);
  return v;
}

export type ImportResult =
  | { status: "imported" | "dry-run"; threadId: string; sessionId: string; path: string; cwd: string; report: Report; checks: Check[]; approxTokens: number; warnings: string[] }
  | { status: "unchanged"; threadId: string; sessionId: string; path: string }
  | { status: "refused" | "failed"; threadId: string; reason: string; checks?: Check[] };

export type ImportOptions = { dryRun?: boolean; newGeneration?: boolean; includeReasoning?: boolean };

const realCwd = (cwd: string) => {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd.replace(/\/+$/, "");
  }
};

export async function importThread(store: Store, thread: CodexThread, opts: ImportOptions = {}): Promise<ImportResult> {
  const threadId = thread.id;
  const { session, report } = await readCodexThread(thread.rolloutPath);
  session.source.title = thread.title;
  const fingerprint = sha256(JSON.stringify([CONVERTER, opts.includeReasoning ?? false, session.source.files.map((f) => [f.sha256, f.bytesRead])]));
  const warnings: string[] = [];

  // ---- dedupe / generation decision
  const prev = store.latestMapping("codex", threadId, MODE);
  let generation = 0;
  if (prev) {
    const current = fileSha(prev.target_path);
    const state = prev.status === "rolled_back" ? "rolled_back" : current === null ? "missing" : current === prev.target_sha256 ? "intact" : "modified";
    if (state === "intact" && prev.source_fingerprint === fingerprint) return { status: "unchanged", threadId, sessionId: prev.target_session_id, path: prev.target_path };
    if (!opts.newGeneration && state !== "rolled_back") {
      const why = {
        intact: "the Codex thread changed since it was imported (appending new turns arrives in Phase 4)",
        missing: "the imported copy was deleted (likely Claude's cleanupPeriodDays); run `asb restore` to rewrite it",
        modified: "the imported session was continued in Claude; it is never touched",
      }[state];
      return { status: "refused", threadId, reason: `${why}. Re-run with --new-generation to write a fresh separate session.` };
    }
    generation = prev.generation + 1;
  }

  const sessionId = stableUuid(`codex:${threadId}:${MODE}:gen${generation}`);
  if (sessionFilesById(sessionId).length) return { status: "refused", threadId, reason: `session ${sessionId} already exists under ${join("projects", "…")} but is not in the store` };
  const version = claudeVersion();
  if (!VERIFIED_CLAUDE_VERSIONS.includes(version)) warnings.push(`Claude Code ${version} is not in the verified list ${VERIFIED_CLAUDE_VERSIONS.join(", ")}`);
  const cwd = realCwd(session.source.cwd || process.cwd());
  if (!existsSync(cwd)) warnings.push(`original cwd ${cwd} no longer exists; resume with --resume from any folder may not find it`);
  if (existsSync(join(codexHome(), "thread-writer-locks", `${threadId}.lock`))) warnings.push("thread may still be live in Codex; imported up to its last complete line");
  if (report.badLines) warnings.push(`${report.badLines} unparseable source line(s) skipped`);

  const rendered = renderTranscript(session, { sessionId, claudeVersion: version, cwd, importedAt: new Date(), includeReasoning: opts.includeReasoning });
  if (rendered.approxTokens > 150_000) warnings.push(`~${rendered.approxTokens} tokens of history; Claude will likely compact on the first resumed turn (context budget arrives in Phase 2)`);
  const target = join(projectDirFor(cwd), `${sessionId}.jsonl`);
  const pre = [l1(rendered.jsonl), l2(rendered.jsonl, sessionId)];
  if (pre.some((c) => !c.ok)) return { status: "failed", threadId, reason: "rendered transcript failed validation before writing", checks: pre };
  if (opts.dryRun) return { status: "dry-run", threadId, sessionId, path: target, cwd, report, checks: pre, approxTokens: rendered.approxTokens, warnings };

  // ---- journaled add-only write
  const opId = newOpId();
  const expected = sha256(rendered.jsonl);
  store.beginOp({ id: opId, kind: "import", target_path: target, temp_path: tempPathFor(target, opId), expected_sha256: expected, mapping_id: null, detail: { threadId, sessionId } });
  for (const f of session.source.files) store.captureSource("codex", threadId, f.path, f.sha256, f.bytesRead);
  try {
    createExclusive(store, opId, target, rendered.jsonl);
  } catch (e) {
    store.setOp(opId, "rolled_back", { detail: { error: String(e) } });
    return { status: "failed", threadId, reason: `write failed: ${String(e)}` };
  }
  const title = `[Codex] ${thread.title ?? "untitled"}`;
  const checks = [...pre, l2(rendered.jsonl, sessionId), await l3(sessionId, cwd, rendered, title)];
  if (checks.some((c) => !c.ok)) {
    const undo = deleteIfOurs(store, opId, target, expected);
    store.setOp(opId, "rolled_back", { detail: { error: "validation failed after write", undo } });
    return { status: "failed", threadId, reason: "written transcript failed validation; rolled back", checks };
  }
  store.setOp(opId, "verified");
  const lastUuid = [...rendered.entries].reverse().find((e) => "uuid" in e) as { uuid: string };
  store.commitImport(
    opId,
    {
      agent: "codex",
      thread_id: threadId,
      generation,
      mode: MODE,
      converter: CONVERTER,
      source_fingerprint: fingerprint,
      target_session_id: sessionId,
      target_path: target,
      target_sha256: expected,
      target_last_uuid: lastUuid.uuid,
      status: "active",
    },
    rendered.jsonl,
    { ...report, approxTokens: rendered.approxTokens, warnings },
  );
  return { status: "imported", threadId, sessionId, path: target, cwd, report, checks, approxTokens: rendered.approxTokens, warnings };
}

export function rollback(store: Store, sessionId: string): string {
  const m = store.mappingBySession(sessionId);
  if (!m) return `no import recorded for session ${sessionId}`;
  if (m.status === "rolled_back") return "already rolled back";
  if (isSessionLive(sessionId)) return "refused: a running Claude process has this session open";
  const opId = newOpId();
  store.beginOp({ id: opId, kind: "rollback", target_path: m.target_path, temp_path: null, expected_sha256: m.target_sha256, mapping_id: m.id });
  const r = deleteIfOurs(store, opId, m.target_path, m.target_sha256);
  if (r === "modified") {
    store.setOp(opId, "refused");
    return "refused: the session was continued in Claude after import, so it is not ours to delete";
  }
  store.setMappingStatus(m.id, "rolled_back");
  store.setOp(opId, "committed");
  return r === "deleted" ? `removed ${m.target_path} (backup kept)` : "file was already gone; marked rolled back";
}

// Rewrite imported copies that Claude's cleanup deleted, from the store.
export async function restore(store: Store, sessionId?: string): Promise<string[]> {
  const out: string[] = [];
  for (const m of store.mappings()) {
    if (m.status !== "active" || (sessionId && m.target_session_id !== sessionId)) continue;
    if (existsSync(m.target_path)) {
      if (sessionId) out.push(`${m.target_session_id}: present, nothing to restore`);
      continue;
    }
    const data = store.targetCopy(m.id);
    if (sha256(data) !== m.target_sha256) {
      out.push(`${m.target_session_id}: stored copy failed its hash check; not restored`);
      continue;
    }
    const opId = newOpId();
    store.beginOp({ id: opId, kind: "restore", target_path: m.target_path, temp_path: tempPathFor(m.target_path, opId), expected_sha256: m.target_sha256, mapping_id: m.id });
    try {
      createExclusive(store, opId, m.target_path, data);
      store.setOp(opId, "committed");
      out.push(`${m.target_session_id}: restored`);
    } catch (e) {
      if (existsSync(tempPathFor(m.target_path, opId))) unlinkSync(tempPathFor(m.target_path, opId));
      store.setOp(opId, "rolled_back", { detail: { error: String(e) } });
      out.push(`${m.target_session_id}: restore failed: ${String(e)}`);
    }
  }
  return out;
}

export function targetState(m: { status: string; target_path: string; target_sha256: string }): "ok" | "missing" | "continued" | "rolled_back" {
  if (m.status === "rolled_back") return "rolled_back";
  const s = fileSha(m.target_path);
  return s === null ? "missing" : s === m.target_sha256 ? "ok" : "continued";
}
