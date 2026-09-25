import { homedir } from "node:os";
import { join } from "node:path";

// Roots are read per call so tests can point everything at temp dirs via env.
export const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), ".codex");
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
export const asbHome = () =>
  process.env.ASB_HOME ??
  (process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "agent-session-bridge")
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-session-bridge"));
