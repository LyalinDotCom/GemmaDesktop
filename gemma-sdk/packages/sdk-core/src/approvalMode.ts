export type ConversationApprovalMode = "require_approval" | "yolo";

export const DEFAULT_CONVERSATION_APPROVAL_MODE: ConversationApprovalMode = "require_approval";

export function normalizeConversationApprovalMode(value: unknown): ConversationApprovalMode {
  return value === "yolo" ? "yolo" : DEFAULT_CONVERSATION_APPROVAL_MODE;
}

export function shouldRequireToolApproval(mode: ConversationApprovalMode): boolean {
  return mode !== "yolo";
}
