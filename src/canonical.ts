// Canonical session format v1: the agent-neutral middle between readers and writers.
// Closed item kinds; anything a reader does not understand becomes `unsupported` (never throws).
import { z } from "zod";

export const CANONICAL_VERSION = 1;

const at = z.number().int().nonnegative(); // epoch ms

export const ImageRef = z.object({ path: z.string().optional(), dataUrl: z.string().optional() });

export const Item = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user_message"), at, text: z.string(), images: z.array(ImageRef) }),
  z.object({ kind: z.literal("context_injection"), at, label: z.string(), text: z.string() }),
  z.object({ kind: z.literal("agent_message"), at, text: z.string(), final: z.boolean() }),
  z.object({ kind: z.literal("reasoning_summary"), at, text: z.string() }),
  z.object({
    kind: z.literal("command"),
    at,
    command: z.string(),
    cwd: z.string(),
    exitCode: z.number().int().nullable(),
    output: z.string(),
    ok: z.boolean(),
  }),
  z.object({
    kind: z.literal("file_change"),
    at,
    ok: z.boolean(),
    changes: z.array(
      z.object({
        path: z.string(),
        op: z.enum(["add", "update", "delete"]),
        movePath: z.string().nullable(),
        diff: z.string(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("mcp_call"),
    at,
    server: z.string(),
    tool: z.string(),
    args: z.unknown(),
    ok: z.boolean(),
    resultText: z.string(),
    imageCount: z.number().int(),
  }),
  z.object({ kind: z.literal("web_search"), at, query: z.string(), action: z.string() }),
  z.object({ kind: z.literal("image_view"), at, path: z.string() }),
  z.object({ kind: z.literal("subagent"), at, threadId: z.string(), label: z.string() }),
  z.object({ kind: z.literal("extension"), at, name: z.string(), summary: z.string() }),
  z.object({ kind: z.literal("compaction"), at, summary: z.string().nullable() }),
  z.object({ kind: z.literal("unsupported"), at, sourceType: z.string() }),
]);
export type Item = z.infer<typeof Item>;
export type ItemKind = Item["kind"];

export const Turn = z.object({
  id: z.string(),
  status: z.enum(["completed", "aborted", "incomplete"]),
  startedAt: at,
  items: z.array(Item),
});
export type Turn = z.infer<typeof Turn>;

export const Session = z.object({
  canonicalVersion: z.literal(CANONICAL_VERSION),
  source: z.object({
    agent: z.literal("codex"),
    threadId: z.string(),
    title: z.string().nullable(),
    cwd: z.string(),
    gitBranch: z.string().nullable(),
    model: z.string().nullable(),
    cliVersion: z.string(),
    createdAt: at,
    // Every file read, in history order (prefix files first), with the bytes consumed.
    files: z.array(z.object({ path: z.string(), bytesRead: z.number().int(), sha256: z.string() })),
  }),
  turns: z.array(Turn),
});
export type Session = z.infer<typeof Session>;

// What a conversion dropped, downgraded or did not recognize. Counts only: never content.
export type Report = {
  lines: number;
  badLines: number;
  unknownLineTypes: Record<string, number>;
  items: Partial<Record<ItemKind, number>>;
  dropped: Record<string, number>;
  notes: string[];
};

export const emptyReport = (): Report => ({ lines: 0, badLines: 0, unknownLineTypes: {}, items: {}, dropped: {}, notes: [] });
export const bump = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};
