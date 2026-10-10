import type { Exchange, Model } from "./model";
import type { PendingApproval } from "./types";

/** A handed-off question may live in a different conversation from where it was first sent. */
export function approvalExchange(model: Model, approval: PendingApproval): Exchange | null {
  if (!approval.turnId) return model.conversations[approval.conversation]?.at(-1) ?? null;
  return Object.values(model.conversations).flat().find((e) => e.turns.includes(approval.turnId!)) ?? null;
}
