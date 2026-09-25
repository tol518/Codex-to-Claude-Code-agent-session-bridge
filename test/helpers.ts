// Test environment: every test gets its own temp CODEX_HOME / CLAUDE_CONFIG_DIR / ASB_HOME.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TestEnv = { root: string; codex: string; claude: string; asb: string; work: string; cleanup: () => void };

export function makeEnv(): TestEnv {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "asb-test-")));
  const env = { root, codex: join(root, "codex"), claude: join(root, "claude"), asb: join(root, "asb"), work: join(root, "work", "repo") };
  for (const d of [env.codex, env.claude, env.work]) mkdirSync(d, { recursive: true });
  const saved = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ASB_HOME: process.env.ASB_HOME, ASB_CLAUDE_VERSION: process.env.ASB_CLAUDE_VERSION };
  Object.assign(process.env, { CODEX_HOME: env.codex, CLAUDE_CONFIG_DIR: env.claude, ASB_HOME: env.asb, ASB_CLAUDE_VERSION: "2.1.268" });
  return {
    ...env,
    cleanup: () => {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// Builder for paginated Codex rollouts in the shape seen at rust-v0.155.0-alpha.16.4.
export class Rollout {
  lines: object[] = [];
  ordinal = 0;
  t = Date.parse("2026-09-01T10:00:00Z");
  readonly threadId: string;
  readonly cwd: string;
  constructor(threadId: string, cwd: string, extraMeta: object = {}) {
    this.threadId = threadId;
    this.cwd = cwd;
    this.push("session_meta", { session_id: threadId, id: threadId, timestamp: new Date(this.t).toISOString(), cwd, originator: "codex_work_desktop", cli_version: "0.155.0-alpha.16.4", source: "vscode", model_provider: "openai", history_mode: "paginated", git: { branch: "main" }, ...extraMeta });
  }
  push(type: string, payload: object) {
    this.t += 1000;
    this.lines.push({ timestamp: new Date(this.t).toISOString(), ordinal: this.ordinal++, type, payload });
    return this;
  }
  event(payload: object) {
    return this.push("event_msg", payload);
  }
  item(turnId: string, item: object) {
    return this.event({ type: "item_completed", thread_id: this.threadId, turn_id: turnId, item, completed_at_ms: this.t + 1000 });
  }
  turn(turnId: string, user: string, body: (r: this) => void, end: "task_complete" | "turn_aborted" | null = "task_complete") {
    this.event({ type: "task_started", turn_id: turnId, started_at: Math.floor(this.t / 1000) });
    this.item(turnId, { type: "UserMessage", id: `u-${turnId}`, content: [{ type: "text", text: user, text_elements: [] }] });
    body(this);
    if (end) this.event({ type: end, turn_id: turnId });
    return this;
  }
  text() {
    return this.lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  }
  write(codexHome: string, rolloutId = this.threadId): string {
    const dir = join(codexHome, "sessions", "2026", "09", "01");
    mkdirSync(dir, { recursive: true });
    const name = rolloutId === this.threadId ? `rollout-2026-09-01T10-00-00-${this.threadId}.jsonl` : `rollout-2026-09-01T10-00-00-${this.threadId}_${rolloutId}.jsonl`;
    const path = join(dir, name);
    writeFileSync(path, this.text());
    return path;
  }
}

export const agent = (text: string, phase = "final_answer") => ({ type: "AgentMessage", id: `m-${text.length}`, content: [{ type: "Text", text }], phase });
export const command = (cmd: string, exit = 0, cwd = "file:///work/repo") => ({
  type: "CommandExecution",
  id: `exec-${cmd.length}`,
  command: ["/bin/zsh", "-lc", cmd],
  cwd,
  parsed_cmd: [],
  source: "unified_exec_startup",
  status: exit === 0 ? "completed" : "failed",
  aggregated_output: exit === 0 ? "ok\n" : "boom: it failed\n",
  exit_code: exit,
});
