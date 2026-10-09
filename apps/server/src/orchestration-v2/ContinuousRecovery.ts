import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";

type RecoveryProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "turnItems" | "providerThreads" | "runtimeRequests" | "subagents"
>;

/** Decide under the thread lock; background work keeps the mode armed without polling the model. */
export function continuousRecoveryDecision(
  projection: RecoveryProjection,
  hasRunningConsole: boolean,
  nowMs: number,
) {
  const recovery = projection.thread.continuousRecovery;
  if (
    recovery == null ||
    projection.thread.archivedAt !== null ||
    projection.thread.deletedAt !== null ||
    projection.thread.settledOverride === "settled"
  )
    return { type: "wait" } as const;
  if (
    projection.runs.some((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    ) ||
    projection.runtimeRequests.some((request) => request.status === "pending")
  )
    return { type: "wait" } as const;

  const latestRun = latestExecutedRun(projection.runs);
  const pendingTasks = projection.subagents.some(
    (task) =>
      ["pending", "running", "waiting"].includes(task.status) ||
      (task.origin === "app_owned" &&
        task.completionDelivery !== undefined &&
        ["pending", "claimed"].includes(task.completionDelivery.state)),
  );
  const backgroundWork = derivePendingBackgroundWork({
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    runs: projection.runs,
    pullRequests: projection.thread.pullRequests,
  });
  const queued = projection.runs.some((run) => run.status === "queued");
  // Background updates can complete a run that previously reported a limit.
  // Keep its root error deadline until a response finishes after that reset.
  const runsById = new Map(projection.runs.map((run) => [run.id, run]));
  let resetMs = 0;
  for (const item of projection.turnItems) {
    if (item.type !== "error" || item.status !== "failed" || item.failure?.class !== "usage_limit")
      continue;
    const run = item.runId === null ? undefined : runsById.get(item.runId);
    if (
      run === undefined ||
      run.providerInstanceId !== projection.thread.providerInstanceId ||
      item.nodeId !== run.rootNodeId
    )
      continue;
    const reset = Date.parse(item.failure.resetAt ?? "");
    if (Number.isFinite(reset)) resetMs = Math.max(resetMs, reset);
  }
  const completedAt =
    latestRun?.status === "completed" && latestRun.completedAt !== null
      ? DateTime.toEpochMillis(latestRun.completedAt)
      : null;
  const awaitingQuotaRecovery = resetMs > 0 && (completedAt === null || completedAt < resetMs);
  if (awaitingQuotaRecovery && resetMs > nowMs) return { type: "wait" } as const;
  if (
    projection.thread.snoozedUntil != null &&
    DateTime.toEpochMillis(projection.thread.snoozedUntil) > nowMs
  )
    return { type: "wait" } as const;

  if (completedAt !== null) {
    if (queued) return { type: "resume_queue" } as const;
    if (hasRunningConsole || backgroundWork.length > 0 || pendingTasks) {
      return { type: "wait" } as const;
    }
    if (!awaitingQuotaRecovery) {
      // Native completions can commit before their wake is offered. Keep the
      // intent until a later foreground response has observed those results.
      const unobservedNativeResult = projection.subagents.some(
        (task) =>
          task.origin === "provider_native" &&
          ["completed", "failed", "cancelled"].includes(task.status) &&
          DateTime.toEpochMillis(task.completedAt ?? task.updatedAt) > completedAt,
      );
      if (!unobservedNativeResult) return { type: "finished" } as const;
    }
  }
  const dueAt = Math.max(Date.parse(recovery.nextAttemptAt), resetMs);
  if (dueAt > nowMs) return { type: "wait" } as const;
  return {
    type: "continue",
    nextAttemptAt: DateTime.formatIso(
      DateTime.makeUnsafe(
        nowMs +
          (latestRun?.status === "completed"
            ? 30_000
            : Math.min(60_000 * 2 ** Math.min(recovery.attempt, 4), 900_000)),
      ),
    ),
  } as const;
}
