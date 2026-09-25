// Byte-exact JSONL streaming for Codex rollouts. Read-only.
// Stops at the last complete newline: a live rollout may be mid-write, and Codex's
// history_base.end_byte_offset is measured in these same (decompressed) bytes.
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createZstdDecompress } from "node:zlib";
import type { Readable } from "node:stream";

export type Line = { offset: number; text: string };
export type ReadResult = { lines: Line[]; bytesRead: number; sha256: string };

export async function readLines(path: string, limitBytes = Infinity): Promise<ReadResult> {
  let stream: Readable = createReadStream(path);
  if (path.endsWith(".zst")) stream = stream.pipe(createZstdDecompress());
  const hash = createHash("sha256");
  const lines: Line[] = [];
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let pos = 0; // bytes seen
  let consumed = 0; // bytes up to and including the last complete newline
  outer: for await (const chunk of stream as AsyncIterable<Buffer>) {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl === -1) {
        pending.push(chunk.subarray(start));
        pendingLen += chunk.length - start;
        break;
      }
      const piece = chunk.subarray(start, nl);
      const lineStart = pos + start - pendingLen;
      const end = pos + nl + 1;
      if (end > limitBytes) break outer;
      const buf = pendingLen ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      pendingLen = 0;
      hash.update(buf).update("\n");
      if (buf.length) lines.push({ offset: lineStart, text: buf.toString("utf8") });
      consumed = end;
      start = nl + 1;
    }
    pos += chunk.length;
  }
  stream.destroy();
  return { lines, bytesRead: consumed, sha256: hash.digest("hex") };
}
