import { canResolve, evalPredicate, type Projection } from "./room.ts";

const TERMINAL = new Set(["DECLINED", "REJECTED", "CANCELLED", "EXPIRED", "RESOLVED"]);

/** Personal next actions derived solely from admitted state; prose cannot create obligations. */
export function renderObligations(projection: Projection, actor: string): string {
  const lines: string[] = [];
  for (const [id, work] of Object.entries(projection.work).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (TERMINAL.has(work.state)) continue;
    const label = `${id} (${work.state}):`;
    if (work.state === "OPEN" && work.assignee_addressed.includes(actor)) {
      lines.push(`${label} respond with work.accept or work.decline.`);
    }
    if (work.state === "COMMITTED" && work.responsible === actor) {
      lines.push(`${label} deliver with work.result; required artifacts: ${work.deliverables.join(", ") || "none specified"}.`);
    }
    if (work.state === "REVIEW") {
      for (const [requirement, rule] of Object.entries(work.requirements)) {
        if (rule.status !== "open" || rule.pos.includes(actor) || rule.neg.includes(actor) ||
            (rule.eligible.length > 0 && !rule.eligible.includes(actor))) continue;
        const verbs = rule.kind === "human_review" ? "human.approve or human.reject" : "verification.pass or verification.fail";
        lines.push(`${label} review requirement ${JSON.stringify(requirement)} with ${verbs}; result_ref=${JSON.stringify(work.result)}; provide explicit evidence.`);
      }
    }
    if (actor === work.requester || actor === work.resolver) {
      if (canResolve(projection, id)) {
        lines.push(`${label} requirements satisfied; submit work.resolve.`);
      } else {
        const blockers = work.state === "OPEN" ? "assignee response" : work.state === "COMMITTED" ? "result delivery" : [
          ...Object.entries(work.requirements).filter(([, rule]) => rule.status !== "satisfied").map(([key]) => key),
          ...work.guards.filter((guard) => guard.kind === "resolve_if" && !evalPredicate(projection, guard.predicate)).map(() => "resolve_if predicate"),
        ].join(", ");
        lines.push(`${label} resolution blocked by ${blockers}; work.cancel is available.`);
      }
    }
    const involved = actor === work.requester || actor === work.resolver ||
      work.assignee_addressed.includes(actor) || Object.values(work.requirements).some((rule) =>
        rule.eligible.length === 0 || rule.eligible.includes(actor));
    if (involved) {
      const waiting: string[] = [];
      if (work.state === "OPEN" && !work.assignee_addressed.includes(actor)) {
        waiting.push(`${work.assignee_addressed.join(", ")} to accept or decline`);
      } else if (work.state === "COMMITTED" && work.responsible !== actor) {
        waiting.push(`${work.responsible} to deliver the result`);
      } else if (work.state === "REVIEW") {
        for (const [requirement, rule] of Object.entries(work.requirements)) {
          if (rule.status !== "open") continue;
          const pending = rule.eligible.filter((who) => who !== actor && !rule.pos.includes(who) && !rule.neg.includes(who));
          if (pending.length) waiting.push(`${pending.join(", ")} to review ${requirement}`);
        }
        if (canResolve(projection, id) && actor !== work.requester && actor !== work.resolver) {
          waiting.push(`${work.requester}${typeof work.resolver === "string" ? ` or ${work.resolver}` : ""} to resolve`);
        }
      }
      if (waiting.length) lines.push(`${label} WAITING ON OTHERS: ${waiting.join("; ")}.`);
    }
    for (const guard of work.guards) {
      if (guard.kind === "escalate" && guard.target === actor && evalPredicate(projection, guard.predicate)) {
        lines.push(`${label} escalation requests your attention.`);
      }
    }
  }
  return lines.join("\n") || "No outstanding obligations.";
}
