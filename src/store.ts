// The bridge's own durable store ($ASB_HOME/asb.sqlite). Claude deletes transcripts after
// cleanupPeriodDays, so the copy under ~/.claude is never the durable one: raw source bytes,
// every written target and the operation journal live here.
import { chmodSync, closeSync, mkdirSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { asbHome } from "./env.ts";

const SCHEMA = `
create table if not exists sources (
  id integer primary key,
  agent text not null,
  thread_id text not null,
  path text not null,
  sha256 text not null,
  bytes_read integer not null,
  captured_at integer not null,
  unique (agent, path, sha256)
);
create table if not exists raw_chunks (
  source_id integer not null references sources(id),
  seq integer not null,
  data blob not null,
  primary key (source_id, seq)
);
create table if not exists blobs (
  sha256 text primary key,
  data blob not null
);
create table if not exists mappings (
  id integer primary key,
  agent text not null,
  thread_id text not null,
  generation integer not null,
  mode text not null,
  converter text not null,
  source_fingerprint text not null,
  target_session_id text not null unique,
  target_path text not null,
  target_sha256 text not null,
  target_last_uuid text not null,
  status text not null check (status in ('active', 'rolled_back')),
  created_at integer not null,
  unique (agent, thread_id, generation, mode)
);
create table if not exists target_copies (
  mapping_id integer primary key references mappings(id),
  data blob not null
);
create table if not exists reports (
  mapping_id integer primary key references mappings(id),
  json text not null
);
create table if not exists ops (
  id text primary key,
  kind text not null check (kind in ('import', 'rollback', 'restore')),
  state text not null,
  target_path text not null,
  temp_path text,
  expected_sha256 text,
  mapping_id integer,
  detail text,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists backups (
  op_id text not null references ops(id),
  original_path text not null,
  backup_path text not null,
  sha256 text not null
);
`;

const CHUNK = 16 * 1024 * 1024;
// Screenshots dominate Codex rollouts and repeat (compaction replacement_history re-embeds them):
// on 895 MB of real rollouts, 653 MB was base64 images of which 177 MB unique. Raw chunks store
// each canonical base64 payload once in `blobs`, leaving NUL-delimited markers; a NUL byte can
// never occur in valid JSONL text, so markers cannot collide with content.
const IMAGE_RE = /(data:image\/[a-z+.-]+;base64,)([A-Za-z0-9+/=]{1024,})/g;
const MARKER_RE = /\x00B([0-9a-f]{64})\x00/g;
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

export type Mapping = {
  id: number;
  agent: string;
  thread_id: string;
  generation: number;
  mode: string;
  converter: string;
  source_fingerprint: string;
  target_session_id: string;
  target_path: string;
  target_sha256: string;
  target_last_uuid: string;
  status: "active" | "rolled_back";
  created_at: number;
};
export type Op = {
  id: string;
  kind: "import" | "rollback" | "restore";
  state: string;
  target_path: string;
  temp_path: string | null;
  expected_sha256: string | null;
  mapping_id: number | null;
  detail: string | null;
};

export class Store {
  readonly db: DatabaseSync;
  readonly home: string;

  constructor(home = asbHome()) {
    this.home = home;
    // Holds full conversations: private to the user.
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    this.db = new DatabaseSync(join(home, "asb.sqlite"));
    for (const f of ["asb.sqlite", "asb.sqlite-wal", "asb.sqlite-shm"]) {
      try {
        chmodSync(join(home, f), 0o600);
      } catch {}
    }
    this.db.exec("pragma journal_mode = wal; pragma synchronous = full; pragma foreign_keys = on;");
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const r = fn();
      this.db.exec("commit");
      return r;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  // Raw source bytes are kept so sessions can be re-rendered when the mapping improves.
  captureSource(agent: string, threadId: string, path: string, sha256: string, bytesRead: number): number {
    const hit = this.db.prepare("select id from sources where agent = ? and path = ? and sha256 = ?").get(agent, path, sha256) as { id: number } | undefined;
    if (hit) return hit.id;
    return this.tx(() => {
      const { lastInsertRowid } = this.db
        .prepare("insert into sources (agent, thread_id, path, sha256, bytes_read, captured_at) values (?, ?, ?, ?, ?, ?)")
        .run(agent, threadId, path, sha256, bytesRead, Date.now());
      const id = Number(lastInsertRowid);
      const put = this.db.prepare("insert into raw_chunks (source_id, seq, data) values (?, ?, ?)");
      const putBlob = this.db.prepare("insert or ignore into blobs (sha256, data) values (?, ?)");
      if (path.endsWith(".zst")) return id; // already compressed at rest by Codex; keep path+sha only
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(CHUNK);
        let carry = "";
        let seq = 0;
        const emit = (text: string) => {
          const packed = text.replace(IMAGE_RE, (whole: string, prefix: string, b64: string) => {
            const bytes = Buffer.from(b64, "base64");
            if (bytes.toString("base64") !== b64) return whole; // non-canonical: keep inline
            const h = sha(b64);
            putBlob.run(h, bytes);
            return `${prefix}\x00B${h}\x00`;
          });
          put.run(id, seq++, zstdCompressSync(Buffer.from(packed)));
        };
        for (let off = 0; off < bytesRead; ) {
          const n = readSync(fd, buf, 0, Math.min(CHUNK, bytesRead - off), off);
          if (n <= 0) break;
          off += n;
          // Chunks end on a newline so an image payload is never split across two chunks.
          const text = carry + buf.subarray(0, n).toString("latin1");
          const cut = text.lastIndexOf("\n") + 1;
          if (cut) emit(Buffer.from(text.slice(0, cut), "latin1").toString("utf8"));
          carry = text.slice(cut);
        }
        if (carry) emit(Buffer.from(carry, "latin1").toString("utf8"));
      } finally {
        closeSync(fd);
      }
      if (sha(this.sourceBytes(id)) !== sha256) throw new Error(`raw capture of ${path} did not round-trip`);
      return id;
    });
  }

  // Byte-exact original source, rebuilt from chunks and blobs.
  sourceBytes(sourceId: number): Buffer {
    const blob = this.db.prepare("select data from blobs where sha256 = ?");
    const parts = (this.db.prepare("select data from raw_chunks where source_id = ? order by seq").all(sourceId) as { data: Uint8Array }[]).map((r) =>
      Buffer.from(
        zstdDecompressSync(r.data)
          .toString("utf8")
          .replace(MARKER_RE, (_: string, h: string) => Buffer.from((blob.get(h) as { data: Uint8Array }).data).toString("base64")),
      ),
    );
    return Buffer.concat(parts);
  }

  latestMapping(agent: string, threadId: string, mode: string): Mapping | undefined {
    return this.db
      .prepare("select * from mappings where agent = ? and thread_id = ? and mode = ? order by generation desc limit 1")
      .get(agent, threadId, mode) as Mapping | undefined;
  }

  mappingBySession(sessionId: string): Mapping | undefined {
    return this.db.prepare("select * from mappings where target_session_id = ?").get(sessionId) as Mapping | undefined;
  }

  mappings(): Mapping[] {
    return this.db.prepare("select * from mappings order by created_at desc").all() as unknown as Mapping[];
  }

  // The mapping and the op's `committed` state land in one transaction, so recovery can never
  // see a committed mapping whose op still looks unfinished (and delete its file).
  commitImport(opId: string, m: Omit<Mapping, "id" | "created_at">, jsonl: string, report: unknown): number {
    const id = this.tx(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          `insert into mappings (agent, thread_id, generation, mode, converter, source_fingerprint, target_session_id,
            target_path, target_sha256, target_last_uuid, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(m.agent, m.thread_id, m.generation, m.mode, m.converter, m.source_fingerprint, m.target_session_id, m.target_path, m.target_sha256, m.target_last_uuid, m.status, Date.now());
      const id = Number(lastInsertRowid);
      this.db.prepare("insert into target_copies (mapping_id, data) values (?, ?)").run(id, zstdCompressSync(Buffer.from(jsonl)));
      this.db.prepare("insert into reports (mapping_id, json) values (?, ?)").run(id, JSON.stringify(report));
      this.db.prepare("update ops set state = 'committed', mapping_id = ?, updated_at = ? where id = ?").run(id, Date.now(), opId);
      return id;
    });
    if (process.env.ASB_TEST_KILL_AT === "committed") process.kill(process.pid, "SIGKILL");
    return id;
  }

  setMappingStatus(id: number, status: Mapping["status"]) {
    this.db.prepare("update mappings set status = ? where id = ?").run(status, id);
  }

  targetCopy(mappingId: number): string {
    const row = this.db.prepare("select data from target_copies where mapping_id = ?").get(mappingId) as { data: Uint8Array };
    return zstdDecompressSync(row.data).toString("utf8");
  }

  report(mappingId: number): unknown {
    const row = this.db.prepare("select json from reports where mapping_id = ?").get(mappingId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }

  // ---- operation journal: planned -> staged -> written -> verified -> committed | rolled_back
  beginOp(op: Omit<Op, "state" | "detail"> & { detail?: unknown }) {
    const now = Date.now();
    this.db
      .prepare("insert into ops (id, kind, state, target_path, temp_path, expected_sha256, mapping_id, detail, created_at, updated_at) values (?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?)")
      .run(op.id, op.kind, op.target_path, op.temp_path, op.expected_sha256, op.mapping_id, JSON.stringify(op.detail ?? null), now, now);
    if (process.env.ASB_TEST_KILL_AT === "planned") process.kill(process.pid, "SIGKILL");
  }

  setOp(id: string, state: string, patch: { mapping_id?: number; detail?: unknown } = {}) {
    this.db
      .prepare("update ops set state = ?, mapping_id = coalesce(?, mapping_id), detail = coalesce(?, detail), updated_at = ? where id = ?")
      .run(state, patch.mapping_id ?? null, patch.detail === undefined ? null : JSON.stringify(patch.detail), Date.now(), id);
    // Crash-injection hook for the kill -9 recovery test: die right after this state is durable.
    if (process.env.ASB_TEST_KILL_AT === state) process.kill(process.pid, "SIGKILL");
  }

  openOps(): Op[] {
    return this.db.prepare("select * from ops where state not in ('committed', 'rolled_back', 'refused') order by created_at").all() as unknown as Op[];
  }

  addBackup(opId: string, original: string, backup: string, sha256: string) {
    this.db.prepare("insert into backups (op_id, original_path, backup_path, sha256) values (?, ?, ?, ?)").run(opId, original, backup, sha256);
  }
}
