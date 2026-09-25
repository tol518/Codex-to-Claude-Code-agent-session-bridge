// Claude Code project folders and session-file lookups (verified against CLI 2.1.268, see COMPAT.md §4).
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../env.ts";

const MAX = 200;

export function sanitizeProjectPath(path: string): string {
  const s = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (s.length <= MAX) return s;
  let h = 0;
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0;
  return `${s.slice(0, MAX)}-${Math.abs(h).toString(36)}`;
}

export const projectsRoot = () => join(claudeHome(), "projects");

// Claude keys folders by the real path; macOS volumes are case-insensitive, so reuse an
// existing folder that differs only by case instead of creating a second one.
export function projectDirFor(cwd: string): string {
  let real = cwd.replace(/\/+$/, "");
  try {
    real = realpathSync(real);
  } catch {}
  const name = sanitizeProjectPath(real);
  const root = projectsRoot();
  if (process.platform === "darwin" && existsSync(root)) {
    const hit = readdirSync(root).find((d) => d.toLowerCase() === name.toLowerCase());
    if (hit) return join(root, hit);
  }
  return join(root, name);
}

// `claude --resume <id>` rejects an id present in more than one project folder.
export function sessionFilesById(sessionId: string): string[] {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((d) => join(root, d, `${sessionId}.jsonl`))
    .filter((p) => existsSync(p));
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

// A running Claude process registers $CLAUDE_CONFIG_DIR/sessions/<pid>.json with its sessionId.
export function isSessionLive(sessionId: string): boolean {
  const dir = join(claudeHome(), "sessions");
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    const m = /^(\d+)\.json$/.exec(f);
    if (!m) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), "utf8")) as { sessionId?: string };
      if (d.sessionId === sessionId && alive(Number(m[1]))) return true;
    } catch {}
  }
  return false;
}
