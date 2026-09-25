// Add-only atomic file creation, hash-guarded deletion with backups, and journal recovery.
// Invariant: this tool never overwrites an existing file, and never deletes a file whose
// current bytes differ from what it wrote (that means the user continued the session).
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Store } from "./store.ts";

export const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export const fileSha = (path: string) => (existsSync(path) ? sha256(readFileSync(path)) : null);
export const newOpId = () => `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
export const tempPathFor = (target: string, opId: string) => join(dirname(target), `.asb-${opId}.tmp`);

function fsyncDir(dir: string) {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// temp in the same folder -> fsync -> link() (fails if the target exists) -> fsync folder.
// A crash at any point leaves either no target or a complete one, plus at most a stray temp.
export function createExclusive(store: Store, opId: string, target: string, data: string) {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = tempPathFor(target, opId);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  store.setOp(opId, "staged");
  try {
    linkSync(tmp, target);
  } finally {
    unlinkSync(tmp);
  }
  fsyncDir(dir);
  store.setOp(opId, "written");
}

export function backupFile(store: Store, opId: string, path: string): string {
  const dir = join(store.home, "backups", opId);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(path));
  copyFileSync(path, dest);
  const digest = fileSha(dest);
  if (!digest || digest !== fileSha(path)) throw new Error(`backup of ${path} did not verify`);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ original: path, sha256: digest }, null, 1) + "\n");
  store.addBackup(opId, path, dest, digest);
  return dest;
}

// Delete only when the file still holds exactly the bytes we wrote.
export function deleteIfOurs(store: Store, opId: string, path: string, expectedSha: string): "deleted" | "missing" | "modified" {
  const current = fileSha(path);
  if (current === null) return "missing";
  if (current !== expectedSha) return "modified";
  backupFile(store, opId, path);
  unlinkSync(path);
  fsyncDir(dirname(path));
  return "deleted";
}

// Runs at every start: resolve operations a crash (kill -9, full disk) left half-done.
export function recover(store: Store): string[] {
  const notes: string[] = [];
  for (const op of store.openOps()) {
    if (op.temp_path && existsSync(op.temp_path)) unlinkSync(op.temp_path);
    if (op.kind === "rollback") {
      // A rollback that got as far as the backup either deleted the target or did not; both are safe end states.
      store.setOp(op.id, existsSync(op.target_path) ? "rolled_back" : "committed", { detail: { recovered: true } });
      notes.push(`recovered rollback ${op.id}`);
      continue;
    }
    // import/restore that never committed: undo our own write, keep anything else.
    const current = fileSha(op.target_path);
    if (current !== null && current === op.expected_sha256 && op.state !== "planned") {
      backupFile(store, op.id, op.target_path);
      unlinkSync(op.target_path);
      fsyncDir(dirname(op.target_path));
      notes.push(`recovered ${op.kind} ${op.id}: removed uncommitted ${basename(op.target_path)}`);
    } else notes.push(`recovered ${op.kind} ${op.id}: nothing to undo`);
    store.setOp(op.id, "rolled_back", { detail: { recovered: true, fromState: op.state } });
  }
  return notes;
}
