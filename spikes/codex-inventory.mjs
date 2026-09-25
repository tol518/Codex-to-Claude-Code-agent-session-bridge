// Phase 0 spike: inventory Codex rollout line types (read-only). Prints counts, never content.
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.jsonl(\.zst)?$/.test(e.name)) files.push(p);
  }
};
for (const sub of ["sessions", "archived_sessions"]) {
  try { walk(join(home, sub)); } catch {}
}

const count = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
const lineTypes = new Map(), payloadTypes = new Map(), itemTypes = new Map(), historyModes = new Map(), sources = new Map();
let zst = 0, bad = 0, bytes = 0, subagent = 0;
for (const f of files) {
  bytes += statSync(f).size;
  let stream = createReadStream(f);
  if (f.endsWith(".zst")) { zst++; stream = stream.pipe(createZstdDecompress()); }
  let first = true;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { bad++; continue; }
    count(lineTypes, d.type);
    const p = d.payload ?? {};
    count(payloadTypes, `${d.type}/${p.type ?? "-"}`);
    if (p.type === "item_completed" || p.type === "item_started") count(itemTypes, p.item?.type ?? "?");
    if (first && d.type === "session_meta") {
      count(historyModes, p.history_mode ?? "legacy");
      const src = typeof p.source === "string" ? p.source : Object.keys(p.source ?? {})[0] ?? "?";
      count(sources, src);
      if (src === "subagent" || p.source?.subagent) subagent++;
    }
    first = false;
  }
}
const top = (m) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
console.log(JSON.stringify({ files: files.length, zst, bytes, bad, subagent, historyModes: top(historyModes), sources: top(sources), lineTypes: top(lineTypes), itemTypes: top(itemTypes), payloadTypes: top(payloadTypes) }, null, 1));
