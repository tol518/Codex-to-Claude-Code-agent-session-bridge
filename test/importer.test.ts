import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectDirFor } from "../src/claude/project.ts";
import { listThreads } from "../src/codex/threads.ts";
import type { CodexThread } from "../src/codex/threads.ts";
import { importThread, restore, rollback } from "../src/importer.ts";
import { createExclusive, fileSha, recover, sha256, tempPathFor } from "../src/safety.ts";
import { Store } from "../src/store.ts";
import { agent, command, makeEnv, Rollout } from "./helpers.ts";
import type { TestEnv } from "./helpers.ts";

let env: TestEnv;
let store: Store;
beforeEach(() => {
  env = makeEnv();
  store = new Store();
});
afterEach(() => {
  store.close();
  env.cleanup();
});

const THREAD = "77777777-7777-7777-8777-777777777777";
function codexThread(extraTurn = false): { thread: CodexThread; path: string; rollout: Rollout } {
  const r = new Rollout(THREAD, env.work);
  r.turn("t1", "what does main.ts do?", (x) => {
    x.item("t1", command("cat main.ts"));
    x.item("t1", agent("It starts the server."));
  });
  if (extraTurn) r.turn("t2", "and tests?", (x) => x.item("t2", agent("There are none.")));
  const path = r.write(env.codex);
  return { path, rollout: r, thread: { id: THREAD, rolloutPath: path, kind: "native", title: "Explain main", cwd: env.work, archived: false, updatedAt: 0 } };
}

describe("import", () => {
  it("writes a transcript that passes L1-L3, and a re-run is a no-op", async () => {
    const { thread } = codexThread();
    const r = await importThread(store, thread);
    expect(r.status).toBe("imported");
    if (r.status !== "imported") return;
    expect(r.checks.map((c) => [c.level, c.ok])).toEqual([["L1", true], ["L2", true], ["L2", true], ["L3", true]]);
    expect(r.path).toBe(join(projectDirFor(env.work), `${r.sessionId}.jsonl`));
    const again = await importThread(store, thread);
    expect(again).toMatchObject({ status: "unchanged", sessionId: r.sessionId });
    expect(readdirSync(projectDirFor(env.work)).filter((f) => f.endsWith(".jsonl"))).toHaveLength(1);
  });

  it("dry-run writes nothing", async () => {
    const r = await importThread(store, codexThread().thread, { dryRun: true });
    expect(r.status).toBe("dry-run");
    expect(existsSync(join(env.claude, "projects"))).toBe(false);
    expect(store.mappings()).toHaveLength(0);
  });

  it("never touches a session continued in Claude; --new-generation writes a separate one", async () => {
    const { thread } = codexThread();
    const first = await importThread(store, thread);
    if (first.status !== "imported") throw new Error(first.status);
    appendFileSync(first.path, JSON.stringify({ type: "last-prompt", lastPrompt: "x", sessionId: first.sessionId }) + "\n");
    const continued = readFileSync(first.path, "utf8");
    expect((await importThread(store, thread)).status).toBe("refused");
    expect(rollback(store, first.sessionId)).toMatch(/continued in Claude/);
    expect(readFileSync(first.path, "utf8")).toBe(continued);
    const second = await importThread(store, thread, { newGeneration: true });
    expect(second.status).toBe("imported");
    if (second.status === "imported") expect(second.sessionId).not.toBe(first.sessionId);
    expect(readFileSync(first.path, "utf8")).toBe(continued);
  });

  it("refuses when the Codex thread grew, until --new-generation", async () => {
    const a = codexThread();
    const first = await importThread(store, a.thread);
    const grown = codexThread(true);
    expect((await importThread(store, grown.thread)).status).toBe("refused");
    const next = await importThread(store, grown.thread, { newGeneration: true });
    expect(next.status).toBe("imported");
    expect(store.latestMapping("codex", THREAD, "transcript")?.generation).toBe(1);
    expect(first.status).toBe("imported");
  });

  it("rollback removes only an untouched import and keeps a verified backup", async () => {
    const r = await importThread(store, codexThread().thread);
    if (r.status !== "imported") throw new Error(r.status);
    const digest = fileSha(r.path);
    expect(rollback(store, r.sessionId)).toMatch(/removed/);
    expect(existsSync(r.path)).toBe(false);
    const backups = readdirSync(join(env.asb, "backups"));
    expect(backups).toHaveLength(1);
    expect(fileSha(join(env.asb, "backups", backups[0]!, `${r.sessionId}.jsonl`))).toBe(digest);
  });

  it("refuses rollback while a live Claude process has the session open", async () => {
    const r = await importThread(store, codexThread().thread);
    if (r.status !== "imported") throw new Error(r.status);
    mkdirSync(join(env.claude, "sessions"), { recursive: true });
    writeFileSync(join(env.claude, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: r.sessionId }));
    expect(rollback(store, r.sessionId)).toMatch(/running Claude process/);
    expect(existsSync(r.path)).toBe(true);
  });

  it("restore rewrites a copy that Claude's cleanup deleted, byte-identical", async () => {
    const r = await importThread(store, codexThread().thread);
    if (r.status !== "imported") throw new Error(r.status);
    const digest = fileSha(r.path);
    unlinkSync(r.path);
    expect((await importThread(store, codexThread().thread)).status).toBe("refused");
    expect(await restore(store)).toEqual([`${r.sessionId}: restored`]);
    expect(fileSha(r.path)).toBe(digest);
  });

  it("keeps a byte-exact raw copy of the source, deduplicating images", async () => {
    const r = new Rollout(THREAD, env.work);
    const png = `data:image/png;base64,${Buffer.alloc(3000, 7).toString("base64")}`;
    r.turn("t1", "look", (x) => {
      x.item("t1", { type: "UserMessage", id: "u", content: [{ type: "image", image_url: png }] });
      x.item("t1", { type: "UserMessage", id: "u2", content: [{ type: "image", image_url: png }] });
      x.item("t1", agent("ok"));
    });
    const path = r.write(env.codex);
    const bytes = readFileSync(path);
    const id = store.captureSource("codex", THREAD, path, sha256(bytes), bytes.length);
    expect(store.sourceBytes(id).equals(bytes)).toBe(true);
    const blobs = store.db.prepare("select count(*) as n from blobs").get() as { n: number };
    expect(blobs.n).toBe(1);
  });
});

describe("thread discovery", () => {
  it("classifies subagent and Claude-imported threads without a state DB", async () => {
    new Rollout("88888888-8888-7888-8888-888888888888", env.work).turn("t", "hi", (x) => x.item("t", agent("yo"))).write(env.codex);
    new Rollout("99999999-9999-7999-8999-999999999999", env.work, { source: { subagent: { other: "guardian" } } }).write(env.codex);
    new Rollout("aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa", env.work).write(env.codex);
    writeFileSync(join(env.codex, "external_agent_session_imports.json"), JSON.stringify({ records: [{ imported_thread_id: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa" }] }));
    const kinds = Object.fromEntries((await listThreads()).map((t) => [t.id[0], t.kind]));
    expect(kinds).toEqual({ "8": "native", "9": "subagent", a: "claude-import" });
  });
});

describe("crash safety", () => {
  it("add-only: an existing target is never overwritten and the temp is cleaned up", () => {
    const target = join(env.root, "t", "s.jsonl");
    mkdirSync(join(env.root, "t"));
    writeFileSync(target, "original\n");
    store.beginOp({ id: "op1", kind: "import", target_path: target, temp_path: tempPathFor(target, "op1"), expected_sha256: sha256("new\n"), mapping_id: null });
    expect(() => createExclusive(store, "op1", target, "new\n")).toThrow(/EEXIST/);
    expect(readFileSync(target, "utf8")).toBe("original\n");
    expect(readdirSync(join(env.root, "t"))).toEqual(["s.jsonl"]);
  });

  it("recovers a write killed after link but before commit by removing only our own file", () => {
    const target = join(env.root, "t", "s.jsonl");
    store.beginOp({ id: "op2", kind: "import", target_path: target, temp_path: tempPathFor(target, "op2"), expected_sha256: sha256("ours\n"), mapping_id: null });
    createExclusive(store, "op2", target, "ours\n"); // state: written, no mapping (simulated kill -9 here)
    expect(recover(store)).toEqual([expect.stringMatching(/removed uncommitted/)]);
    expect(existsSync(target)).toBe(false);
    expect(store.openOps()).toEqual([]);
  });

  it("recovers a write killed between fsync and link: stray temp removed, no target", () => {
    const target = join(env.root, "t", "s.jsonl");
    mkdirSync(join(env.root, "t"));
    const tmp = tempPathFor(target, "op3");
    store.beginOp({ id: "op3", kind: "import", target_path: target, temp_path: tmp, expected_sha256: sha256("x\n"), mapping_id: null });
    writeFileSync(tmp, "x\n");
    store.setOp("op3", "staged");
    recover(store);
    expect(readdirSync(join(env.root, "t"))).toEqual([]);
  });

  it("recovery leaves a file alone when its bytes are not ours", () => {
    const target = join(env.root, "t", "s.jsonl");
    mkdirSync(join(env.root, "t"));
    writeFileSync(target, "someone else\n");
    store.beginOp({ id: "op4", kind: "import", target_path: target, temp_path: null, expected_sha256: sha256("ours\n"), mapping_id: null });
    store.setOp("op4", "written");
    recover(store);
    expect(readFileSync(target, "utf8")).toBe("someone else\n");
  });
});

describe("real kill -9 during import", () => {
  const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
  it.each(["planned", "staged", "written", "verified", "committed"])("SIGKILL at %s recovers to a clean, re-importable state", async (state) => {
    const { spawnSync } = await import("node:child_process");
    codexThread();
    store.close();
    const run = (extra: Record<string, string> = {}) => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "import", THREAD], { env: { ...process.env, ...extra }, encoding: "utf8" });
    const killed = run({ ASB_TEST_KILL_AT: state });
    expect(killed.signal).toBe("SIGKILL");
    store = new Store();
    recover(store);
    const dir = projectDirFor(env.work);
    const files = existsSync(dir) ? readdirSync(dir) : [];
    expect(files.filter((f) => f.startsWith(".asb-"))).toEqual([]);
    expect(store.openOps()).toEqual([]);
    const committed = state === "committed";
    expect(files.filter((f) => f.endsWith(".jsonl"))).toHaveLength(committed ? 1 : 0);
    expect(store.mappings()).toHaveLength(committed ? 1 : 0);
    const again = await importThread(store, (await listThreads()).find((t) => t.id === THREAD)!);
    expect(again.status).toBe(committed ? "unchanged" : "imported");
  });
});
