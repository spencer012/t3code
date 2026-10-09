import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";

type RecoveryProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "turnItems" | "providerThreads" | "runtimeRequests" | "subagents"
>;

/** Decide under the thread lock; queued results and running commands are unfinished work. */
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
  if (latestRun?.status === "completed") {
    if (!queued && !hasRunningConsole && backgroundWork.length === 0 && !pendingTasks) {
      return { type: "finished" } as const;
    }
  }
  if (
    projection.thread.snoozedUntil != null &&
    DateTime.toEpochMillis(projection.thread.snoozedUntil) > nowMs
  )
    return { type: "wait" } as const;
  if (latestRun?.status === "completed" && queued) return { type: "resume_queue" } as const;
  // A background wake can replace the failed run before its quota resets.
  const resetMs = projection.runs.reduce((deadline, run) => {
    const failure = latestRootProviderFailure(run, projection.turnItems);
    const reset = failure?.class === "usage_limit" ? Date.parse(failure.resetAt ?? "") : NaN;
    return Number.isFinite(reset) ? Math.max(deadline, reset) : deadline;
  }, 0);
  const dueAt = Math.max(
    Date.parse(recovery.nextAttemptAt),
    Number.isFinite(resetMs) ? resetMs : 0,
  );
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
