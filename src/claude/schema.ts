// L1: the only Claude Code entry shapes this tool writes. Built from CLI 2.1.268 fixtures
// (fixtures/claude/2.1.268/minimal-*.resumed-ok.jsonl). CLIs before 2.1.275 fail to resume
// a transcript with an entry type they cannot read, so nothing outside this union is emitted.
import { z } from "zod";

const uuid = z.uuid();
const base = {
  parentUuid: uuid.nullable(),
  isSidechain: z.literal(false),
  uuid,
  timestamp: z.iso.datetime(),
  sessionId: uuid,
  cwd: z.string().min(1),
  version: z.string().min(1),
  userType: z.literal("external"),
};

export const UserEntry = z.strictObject({
  ...base,
  type: z.literal("user"),
  isMeta: z.literal(true).optional(),
  message: z.strictObject({ role: z.literal("user"), content: z.string().min(1) }),
});

export const AssistantEntry = z.strictObject({
  ...base,
  type: z.literal("assistant"),
  message: z.strictObject({
    id: z.string().startsWith("msg_"),
    type: z.literal("message"),
    role: z.literal("assistant"),
    model: z.literal("<synthetic>"),
    content: z.tuple([z.strictObject({ type: z.literal("text"), text: z.string().min(1) })]),
    stop_reason: z.literal("end_turn"),
    stop_sequence: z.null(),
    usage: z.strictObject({
      input_tokens: z.literal(0),
      output_tokens: z.literal(0),
      cache_creation_input_tokens: z.literal(0),
      cache_read_input_tokens: z.literal(0),
    }),
  }),
});

export const CustomTitleEntry = z.strictObject({ type: z.literal("custom-title"), customTitle: z.string().min(1), sessionId: uuid });

export const Entry = z.union([UserEntry, AssistantEntry, CustomTitleEntry]);
export type UserEntry = z.infer<typeof UserEntry>;
export type AssistantEntry = z.infer<typeof AssistantEntry>;
export type Entry = z.infer<typeof Entry>;
