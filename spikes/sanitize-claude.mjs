// Phase 0: structure-preserving sanitizer for Claude Code 2.1.268 transcripts captured in spikes/work1.
// Keeps entry shapes, uuids, chain links and enum-like fields; replaces all content and local paths.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const OUT = new URL("../fixtures/claude/2.1.268/", import.meta.url).pathname;
const KEEP = new Set([
  "type", "subtype", "role", "uuid", "parentUuid", "logicalParentUuid", "sessionId", "version", "userType",
  "entrypoint", "id", "name", "tool_use_id", "stop_reason", "stop_sequence", "model", "promptSource",
  "permissionMode", "operation", "promptId", "requestId", "timestamp", "gitBranch", "level", "trigger",
  "service_tier", "speed", "inference_geo", "messageId", "leafUuid", "sourceToolAssistantUUID", "media_type",
  "atis", "mode", "trackingPath",
]);
const ENUMLIKE = /^[A-Za-z0-9_<][A-Za-z0-9_.:>\/-]{0,63}$/;
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const filler = (s) => {
  const n = Math.min(s.length, 2000);
  let out = "";
  while (out.length < n) out += "lorem ipsum dolor sit amet ";
  return out.slice(0, n) + (s.length > 2000 ? `[+${s.length - 2000}]` : "");
};
const clean = (v, key) => {
  if (Array.isArray(v)) return v.map((x) => clean(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k.startsWith("/") ? "/work/file" : k, clean(x, k)]));
  if (typeof v !== "string") return v;
  if (key === "signature") return `SIG:${v.length}`;
  if (key === "data") return TINY_PNG_B64;
  if (key === "cwd" || key === "file_path" || key === "path") return "/work/repo";
  if (KEEP.has(key) && ENUMLIKE.test(v) && !v.includes(HOME)) return v;
  return filler(v);
};

const [srcDir, ...ids] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const labels = { cb2e7694: "plain-turn", "5d967c6b": "two-reads-then-compact", f86a0257: "tool-error-missing-file", efb08560: "image-read", "3347c470": "bash-nonzero-exit" };
for (const f of readdirSync(srcDir).filter((x) => x.endsWith(".jsonl"))) {
  const label = labels[f.slice(0, 8)];
  if (!label && !ids.includes(f.slice(0, 36))) continue;
  const lines = readFileSync(join(srcDir, f), "utf8").split("\n").filter(Boolean);
  const out = lines.map((l) => JSON.stringify(clean(JSON.parse(l), "")));
  writeFileSync(join(OUT, `${label ?? "synthetic-" + f.slice(0, 8)}.jsonl`), out.join("\n") + "\n");
  console.log(label ?? f, out.length);
}
