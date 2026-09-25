// Phase 0 spike: L3 official read-back via the pinned Agent SDK.
// Usage: node spikes/readback.mjs <sessionId> <cwd>
import { getSessionMessages, getSessionInfo, listSessions } from "@anthropic-ai/claude-agent-sdk";

const [id, dir] = process.argv.slice(2);
const msgs = await getSessionMessages(id, { dir, includeSystemMessages: true });
const info = await getSessionInfo(id, { dir });
const listed = (await listSessions({ dir })).find((s) => s.sessionId === id);
console.log(
  JSON.stringify(
    {
      count: msgs.length,
      shapes: msgs.map((m) => `${m.type}:${(Array.isArray(m.message?.content) ? m.message.content.map((b) => b.type) : [typeof m.message?.content]).join("+")}`),
      info,
      listed: Boolean(listed),
    },
    null,
    1,
  ),
);
