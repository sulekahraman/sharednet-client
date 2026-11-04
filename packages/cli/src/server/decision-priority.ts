import type { Decision, DecisionPriority } from "../protocol/index.ts";

export type DecisionPrioritySource = "pending" | "model" | "owner" | "fallback";
export type DecisionPriorityEvaluationState = "pending" | "processing" | "succeeded" | "failed" | "superseded";
export type DecisionPriorityFailureCategory = "timeout" | "rate_limited" | "provider_unavailable" | "invalid_response" | "configuration" | "internal";
export type DecisionPriorityEvaluationMetadata = {
  status: "pending" | "processing" | "assigned" | "failed" | "overridden";
  reason: string | null;
  confidence: number | null;
  model: string | null;
  assessed_at: string | null;
};
export type DecisionPriorityEvaluationClaim = { decision: Decision; leaseToken: string; attempts: number };
export type DecisionPriorityAssessment = {
  priority: DecisionPriority;
  reason: string;
  confidence: number;
  provider: string;
  model: string;
  rubricVersion: string;
  inputDigest: string;
};
export const PRIORITY_MAX_ATTEMPTS = 3;
export const priorityRetryMs = (attempts: number) => 30_000 * 2 ** (attempts - 1);
export function priorityLeaseMs(value = 60_000): number {
  if (!Number.isInteger(value) || value < 1000 || value > 300_000) throw new Error("Priority lease must be between 1000 and 300000 milliseconds.");
  return value;
}
export function priorityFailureCategory(value: DecisionPriorityFailureCategory): DecisionPriorityFailureCategory {
  return (["timeout", "rate_limited", "provider_unavailable", "invalid_response", "configuration", "internal"] as const).includes(value) ? value : "internal";
}
export function validatePriorityAssessment(value: DecisionPriorityAssessment): void {
  if (!["p0", "p1", "p2", "p3", "p4"].includes(value.priority) || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 || !value.reason.trim() || value.reason.length > 1000 || !/^[a-f0-9]{64}$/.test(value.inputDigest) || [value.provider, value.model, value.rubricVersion].some(item => !item.trim() || item.length > 200)) throw new Error("Invalid Decision priority assessment.");
}
export function priorityEvaluationMetadata(source: DecisionPrioritySource, evaluation?: {
  state: DecisionPriorityEvaluationState; reason: string | null; confidence: number | null; model: string | null; assessedAt: Date | string | null;
} | null): DecisionPriorityEvaluationMetadata {
  return {
    status: source === "owner" ? "overridden" : evaluation?.state === "succeeded" ? "assigned" : evaluation?.state === "failed" ? "failed" : evaluation?.state === "processing" ? "processing" : "pending",
    reason: evaluation?.reason ?? null,
    confidence: evaluation?.confidence ?? null,
    model: evaluation?.model ?? null,
    assessed_at: evaluation?.assessedAt ? new Date(evaluation.assessedAt).toISOString() : null,
  };
}
