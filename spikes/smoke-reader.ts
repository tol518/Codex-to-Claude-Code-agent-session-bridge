import { listThreads } from "../src/codex/threads.ts";
import { readCodexThread } from "../src/codex/reader.ts";
const threads = (await listThreads()).filter((t) => t.kind === "native");
console.log("native threads", threads.length);
for (const t of threads) {
  const { session, report } = await readCodexThread(t.rolloutPath);
  console.log(t.id.slice(0, 8), "files", session.source.files.length, "turns", session.turns.length, "status", JSON.stringify(Object.groupBy(session.turns, (x) => x.status), (k, v) => (Array.isArray(v) ? v.length : v)), JSON.stringify(report.items), "bad", report.badLines, "unk", JSON.stringify(report.unknownLineTypes), JSON.stringify(report.dropped), report.notes.length);
}
