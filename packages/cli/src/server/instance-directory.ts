import type {
  Agent,
  AgentId,
  InstanceDirectoryResponse,
  InstanceDirectoryState,
  InstanceId,
  PrincipalId,
} from "../protocol/index.ts";
import type { InstanceDirectorySnapshot, PrincipalRepository } from "./repository.ts";

function agentName(agent: Agent): string {
  return agent.display_name ?? agent.handle;
}

function elapsedDetail(lastSeenAt: string, sampledAt: string): string {
  const elapsedMs = Math.max(0, Date.parse(sampledAt) - Date.parse(lastSeenAt));
  const seconds = Math.floor(elapsedMs / 1_000);
  if (seconds < 60) return "last seen just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `last seen ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  return `last seen ${Math.floor(hours / 24)}d ago`;
}

/**
 * Reduces the already-authorized Network view to the deliberately small public
 * directory a caller needs in order to choose one of its own Instances.
 */
export function projectInstanceDirectory(
  snapshot: InstanceDirectorySnapshot,
  principalId: PrincipalId,
): InstanceDirectoryResponse {
  const agentsById = new Map<AgentId, Agent>(snapshot.agents.map((agent) => [agent.id, agent]));
  const activeByInstance = new Map<InstanceId, string>();
  for (const active of snapshot.active) {
    if (!activeByInstance.has(active.instance_id)) {
      activeByInstance.set(active.instance_id, active.room_name);
    }
  }

  const instances = snapshot.instances
    .filter((instance) => instance.principal_id === principalId && instance.status !== "revoked")
    .sort(
      (left, right) =>
        right.last_seen_at.localeCompare(left.last_seen_at) ||
        right.started_at.localeCompare(left.started_at) ||
        right.id.localeCompare(left.id),
    )
    .map((instance) => {
      const agent = instance.agent_id === null ? undefined : agentsById.get(instance.agent_id);
      const workingRoom = instance.status === "online" ? activeByInstance.get(instance.id) : undefined;
      const state: InstanceDirectoryState =
        workingRoom !== undefined ? "working" : instance.status === "online" ? "online" : "offline";
      const detail =
        state === "working"
          ? `replying in ${workingRoom}`
          : state === "online"
            ? "listening"
            : instance.status === "ended"
              ? "ended"
              : instance.status === "expired"
                ? "access expired"
                : elapsedDetail(instance.last_seen_at, snapshot.sampled_at);
      const resolvedAgent = agent
        ? { agent_id: agent.id, name: agentName(agent) }
        : null;

      return {
        instance_id: instance.id,
        name: instance.display_name ?? resolvedAgent?.name ?? instance.runtime_kind,
        agent: resolvedAgent,
        driver: instance.runtime_kind,
        state,
        detail,
        last_seen_at: instance.last_seen_at,
      };
    });

  return { instances };
}

export async function listOwnedInstances(
  repository: PrincipalRepository,
  principalId: PrincipalId,
): Promise<InstanceDirectoryResponse> {
  return projectInstanceDirectory(await repository.instanceDirectoryForPrincipal(principalId), principalId);
}
