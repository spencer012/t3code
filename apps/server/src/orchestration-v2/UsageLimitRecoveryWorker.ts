import { CommandId, MessageId, type OrchestrationV2Command } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const terminals = yield* TerminalManager.TerminalManager;
  const consoleSessions = new Map<string, Map<string, boolean>>();
  const unsubscribe = yield* terminals.subscribeMetadata((event) =>
    Effect.sync(() => {
      if (event.type === "snapshot") consoleSessions.clear();
      if (event.type === "remove") {
        const sessions = consoleSessions.get(event.threadId);
        sessions?.delete(event.terminalId);
        if (sessions?.size === 0) consoleSessions.delete(event.threadId);
        return;
      }
      for (const terminal of event.type === "snapshot" ? event.terminals : [event.terminal]) {
        const sessions = consoleSessions.get(terminal.threadId) ?? new Map<string, boolean>();
        sessions.set(
          terminal.terminalId,
          terminal.status === "starting" || terminal.hasRunningSubprocess,
        );
        consoleSessions.set(terminal.threadId, sessions);
      }
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const continuousThreads = yield* projections.getContinuousRecoveryThreads;
    const nowMs = DateTime.toEpochMillis(now);
    for (const thread of continuousThreads) {
      const recovery = thread.continuousRecovery;
      if (recovery == null) continue;
      const shell = yield* projections.getThreadShell(thread.id);
      if (
        shell === null ||
        shell.pendingRuntimeRequest !== null ||
        ["preparing", "starting", "running", "waiting"].includes(shell.status)
      )
        continue;
      const hasRunningConsole = [...(consoleSessions.get(thread.id)?.values() ?? [])].some(Boolean);
      const resetMs = Date.parse(shell.usageLimitResetAt ?? "");
      const dueAt = Math.max(
        Date.parse(recovery.nextAttemptAt),
        Number.isFinite(resetMs) ? resetMs : 0,
      );
      if (
        dueAt > nowMs &&
        (shell.status !== "completed" ||
          hasRunningConsole ||
          (shell.pendingBackgroundTasks?.length ?? 0) > 0)
      )
        continue;
      const uuid = yield* crypto.randomUUIDv4;
      yield* threads
        .dispatch({
          type: "thread.continuation.check",
          commandId: CommandId.make(`continuous-check:${recovery.requestId}:${uuid}`),
          threadId: thread.id,
          requestId: recovery.requestId,
          attempt: recovery.attempt,
          hasRunningConsole,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.continuous-recovery.dispatch-failed", {
              threadId: thread.id,
              cause,
            }),
          ),
        );
    }
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
    });
    const continuousIds = new Set(continuousThreads.map((thread) => thread.id));
    for (const thread of candidates) {
      if (continuousIds.has(thread.id)) continue;
      const command = limitRecoveryCommand(
        thread,
        preferences.autoResumeLimitedThreads,
        nowMs,
        preferences.snoozeLimitedThreads,
      );
      if (command === null) continue;
      yield* threads.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
