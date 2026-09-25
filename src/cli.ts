// asb: agent-session-bridge CLI.
import { parseArgs } from "node:util";
import { listThreads } from "./codex/threads.ts";
import type { CodexThread } from "./codex/threads.ts";
import { importThread, MODE, refresh, restore, rollback, targetState } from "./importer.ts";
import type { ImportResult } from "./importer.ts";
import { recover } from "./safety.ts";
import { Store } from "./store.ts";

const HELP = `asb: move Codex sessions into resumable Claude Code sessions

  asb list [--all]                 Codex threads (native only unless --all) and their import state
  asb import <thread-id>...        import threads (unique id prefixes work)
      --all-native                 import every native Codex thread
      --dry-run                    render and validate without writing
      --new-generation             write a fresh separate session when the old one changed or was continued
      --include-reasoning          include Codex's readable reasoning summaries
      --json                       machine-readable results
  asb status                       imported sessions and whether their files are ok/missing/continued
  asb rollback <session-id>        remove an import (only if unchanged since import; backup kept)
  asb restore [<session-id>]       rewrite imported copies Claude's cleanup deleted
  asb refresh                      re-render untouched imports after an asb upgrade (new copy first, then old removed)
  asb report <thread-id>           last conversion report (counts only)

Desktop app: after importing, use Help > Troubleshooting > Import Claude Code CLI Sessions… once
to add the sessions to the Code tab sidebar (only folders you have trusted in Claude are offered).

Sources are read-only. Claude files are only added, never overwritten.`;

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function pick(threads: CodexThread[], ids: string[]): CodexThread[] {
  return ids.map((id) => {
    const hits = threads.filter((t) => t.id.startsWith(id));
    if (hits.length !== 1) throw new Error(hits.length ? `id prefix ${id} is ambiguous` : `no Codex thread ${id}`);
    return hits[0]!;
  });
}

function printResult(r: ImportResult) {
  const head = `${r.threadId.slice(0, 13)}  ${r.status}`;
  switch (r.status) {
    case "unchanged":
      return console.log(`${head}  (session ${r.sessionId})`);
    case "refused":
    case "failed":
      console.log(`${head}: ${r.reason}`);
      for (const c of r.checks ?? []) if (!c.ok) console.log(`    ${c.level}: ${c.problems.slice(0, 5).join("; ")}`);
      return;
    case "dry-run":
    case "imported":
      console.log(`${head}  session ${r.sessionId}  ~${r.approxTokens} tokens  ${r.checks.map((c) => `${c.level}:${c.ok ? "ok" : "FAIL"}`).join(" ")}`);
      for (const w of r.warnings) console.log(`    warning: ${w}`);
      if (r.status === "imported") console.log(`    resume: cd ${JSON.stringify(r.cwd)} && claude --resume ${r.sessionId}`);
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      "all-native": { type: "boolean" },
      "dry-run": { type: "boolean" },
      "new-generation": { type: "boolean" },
      "include-reasoning": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help) return console.log(HELP);
  const store = new Store();
  try {
    for (const note of recover(store)) console.error(`recovery: ${note}`);
    const byThread = () => new Map(store.mappings().filter((m) => m.mode === MODE).map((m) => [m.thread_id, m]));
    switch (cmd) {
      case "list": {
        const threads = (await listThreads()).filter((t) => values.all || t.kind === "native");
        const maps = byThread();
        for (const t of threads) {
          const m = maps.get(t.id);
          console.log(`${t.id}  ${day(t.updatedAt)}  ${pad(t.kind, 13)}  ${pad(m ? targetState(m) : "-", 11)}  ${t.title ?? "(untitled)"}`);
        }
        return;
      }
      case "import": {
        const threads = await listThreads();
        const chosen = values["all-native"] ? threads.filter((t) => t.kind === "native") : pick(threads, args);
        if (!chosen.length) throw new Error("nothing to import: pass thread ids or --all-native");
        const results: ImportResult[] = [];
        for (const t of chosen) {
          if (t.kind !== "native" && !values["all-native"]) console.error(`note: ${t.id} is a ${t.kind} thread`);
          const r = await importThread(store, t, { dryRun: values["dry-run"], newGeneration: values["new-generation"], includeReasoning: values["include-reasoning"] });
          results.push(r);
          if (!values.json) printResult(r);
        }
        if (values.json) console.log(JSON.stringify(results.map((r) => ("report" in r ? { ...r, report: r.report } : r)), null, 1));
        process.exitCode = results.some((r) => r.status === "failed") ? 1 : 0;
        return;
      }
      case "status":
        for (const m of store.mappings())
          console.log(`${m.target_session_id}  ${pad(targetState(m), 11)}  gen ${m.generation}  codex ${m.thread_id}  ${day(m.created_at)}`);
        return;
      case "rollback":
        if (!args[0]) throw new Error("usage: asb rollback <session-id>");
        return console.log(rollback(store, args[0]));
      case "refresh":
        for (const line of await refresh(store, await listThreads(), { includeReasoning: values["include-reasoning"] })) console.log(line);
        return;
      case "restore":
        for (const line of await restore(store, args[0])) console.log(line);
        return;
      case "report": {
        const m = args[0] && store.mappings().find((x) => x.thread_id.startsWith(args[0]!));
        if (!m) throw new Error("no import recorded for that thread");
        return console.log(JSON.stringify(store.report(m.id), null, 1));
      }
      default:
        throw new Error(`unknown command ${cmd}\n\n${HELP}`);
    }
  } finally {
    store.close();
  }
}

main().catch((e: unknown) => {
  console.error(`asb: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
});
