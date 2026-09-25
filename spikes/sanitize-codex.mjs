// Phase 0: pick feature-covering real rollouts and write structure-preserving sanitized fixtures.
// Content strings are replaced (same length, capped); only short enum-like values under structural keys survive.
import { createReadStream, readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash, randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join, basename, extname } from "node:path";

const HOME = homedir();
const CODEX = process.env.CODEX_HOME ?? join(HOME, ".codex");
const OUT = new URL("../fixtures/codex/rollouts/", import.meta.url).pathname;
const MAX_LINES = 1500;
const MAX_STR = 4000;

const KEEP = new Set([
  "type", "role", "status", "kind", "phase", "mode", "source", "history_mode", "model", "model_provider",
  "cli_version", "originator", "call_id", "id", "turn_id", "thread_id", "session_id", "root_turn_id",
  "parent_thread_id", "name", "server", "tool", "level", "reason", "method", "effort", "reasoning_effort",
  "personality", "unit", "timestamp", "item_id", "sandbox_policy", "approval_policy", "collaboration_mode",
  "agent_role", "agent_nickname", "exit_code_kind", "operation",
]);
const ENUMLIKE = /^[A-Za-z0-9_][A-Za-z0-9_.:\/-]{0,63}$/;
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Per-run salt (never stored) so placeholder hashes cannot be brute-forced back to guessable real paths.
const SALT = randomBytes(16);
const pathMap = new Map();
const fakePath = (p) => {
  if (!pathMap.has(p)) {
    const h = createHash("sha256").update(SALT).update(p).digest("hex").slice(0, 8);
    pathMap.set(p, `/work/p${h}${extname(p).slice(0, 8)}`);
  }
  return pathMap.get(p);
};
const filler = (s) => {
  const n = Math.min(s.length, MAX_STR);
  const words = "lorem ipsum dolor sit amet consectetur adipiscing elit ";
  let out = "";
  while (out.length < n) out += words;
  return out.slice(0, n) + (s.length > MAX_STR ? `[+${s.length - MAX_STR}]` : "");
};
const looksPath = (s) => s.startsWith("/") || s.startsWith("file://") || s.startsWith("~/");

const clean = (v, key) => {
  if (Array.isArray(v)) return v.map((x) => clean(x, key));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[looksPath(k) ? fakePath(k) : k] = clean(x, k);
    return o;
  }
  if (typeof v !== "string") return v;
  if (key === "encrypted_content") return `ENC:${v.length}`;
  if (v.startsWith("data:image/")) return TINY_PNG;
  if (key === "cwd" || key === "path" || key === "move_path" || looksPath(v)) return v.includes("\n") ? filler(v) : fakePath(v);
  // File names and account-specific model ids reveal private projects/access; keep only their shape.
  if (key === "name" && /\.[A-Za-z0-9]{1,8}$/.test(v)) return `file${extname(v)}`;
  if (key === "model" && !v.startsWith("claude-") && v !== "<synthetic>") return "gpt-5.5";
  if (KEEP.has(key) && ENUMLIKE.test(v) && !v.includes(HOME)) return v;
  return filler(v);
};

// ---- feature scan for selection
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".jsonl")) files.push(p);
  }
};
walk(join(CODEX, "sessions"));
try { walk(join(CODEX, "archived_sessions")); } catch {}

const feats = [];
for (const f of files) {
  const s = { f, lines: 0, feats: new Set() };
  let metas = 0;
  for await (const line of createInterface({ input: createReadStream(f), crlfDelay: Infinity })) {
    s.lines++;
    let d;
    try { d = JSON.parse(line); } catch { s.feats.add("bad-line"); continue; }
    const p = d.payload ?? {};
    if (d.type === "session_meta") {
      metas++;
      s.feats.add(p.history_mode === "paginated" ? "paginated" : "legacy");
      if (p.source?.subagent || p.source === "subagent") s.feats.add("subagent");
    }
    if (p.item?.type) s.feats.add(`item:${p.item.type}`);
    if (d.type === "compacted") s.feats.add("compacted");
    if (p.type === "turn_aborted") s.feats.add("turn_aborted");
    if (p.type === "function_call") s.feats.add("function_call");
    if (d.type === "world_state") s.feats.add("world_state");
    if (d.type === "inter_agent_communication_metadata") s.feats.add("inter_agent");
  }
  if (metas > 1) s.feats.add("multi-meta");
  feats.push(s);
}

// greedy cover: prefer small files that add uncovered features; 2 per rare feature
const want = new Map();
for (const s of feats) for (const x of s.feats) want.set(x, Math.min(2, (want.get(x) ?? 0) + 1));
const picked = [];
const need = new Map(want);
while (picked.length < 14) {
  let best, bestScore = 0;
  for (const s of feats) {
    if (picked.includes(s)) continue;
    const gain = [...s.feats].filter((x) => (need.get(x) ?? 0) > 0).length;
    const score = gain / Math.log10(s.lines + 10);
    if (gain && score > bestScore) { best = s; bestScore = score; }
  }
  if (!best) break;
  picked.push(best);
  for (const x of best.feats) need.set(x, (need.get(x) ?? 0) - 1);
}

mkdirSync(OUT, { recursive: true });
const manifest = [];
for (const [i, s] of picked.entries()) {
  const out = [];
  let n = 0;
  for await (const line of createInterface({ input: createReadStream(s.f), crlfDelay: Infinity })) {
    if (n++ >= MAX_LINES) break;
    try { out.push(JSON.stringify(clean(JSON.parse(line), ""))); } catch { out.push('{"type":"event_msg","payload":{"type":"agent_mess'); }
  }
  const name = `r${String(i + 1).padStart(2, "0")}-${[...s.feats].filter((x) => !x.startsWith("item:")).sort().join("_")}.jsonl`;
  writeFileSync(join(OUT, name), out.join("\n") + "\n");
  manifest.push({ fixture: name, sourceLines: s.lines, keptLines: out.length, truncated: s.lines > MAX_LINES, features: [...s.feats].sort() });
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ capturedWith: "codex-cli 0.155.0-alpha.16.4", maxLines: MAX_LINES, fixtures: manifest }, null, 1) + "\n");

// leak check
// Private terms come from the runtime (and ASB_LEAK_TERMS, comma-separated), never from this file.
const leaks = [HOME, userInfo().username, ...(process.env.ASB_LEAK_TERMS ?? "").split(",").filter(Boolean), "sk-", "ghp_", "gho_"];
let bad = 0;
for (const m of manifest) {
  const txt = readFileSync(join(OUT, m.fixture), "utf8");
  for (const l of leaks) if (txt.toLowerCase().includes(l.toLowerCase())) { console.error("LEAK", m.fixture, JSON.stringify(l)); bad++; }
}
const covered = new Set(manifest.flatMap((m) => m.features));
console.log(JSON.stringify({ picked: manifest.length, missing: [...want.keys()].filter((x) => !covered.has(x)), leaks: bad }, null, 1));
for (const m of manifest) console.log(m.fixture.slice(0, 90), m.keptLines, m.features.filter((x) => x.startsWith("item:")).join(","));
