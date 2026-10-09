import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

it.effect.each(["busy", "idle", "other-thread"] as const)(
  "restores persisted continuation with a %s console and tracks live metadata",
  (scenario) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("continuous:restored");
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project:test"),
        title: "Restored",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
        branch: null,
        worktreePath: null,
        lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
        forkedFrom: null,
        activeProviderThreadId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        continuousRecovery: {
          requestId: CommandId.make("continuous:persisted"),
          attempt: 3,
          nextAttemptAt: DateTime.formatIso(DateTime.subtract(now, { minutes: 1 })),
        },
      };
      const shell: OrchestrationV2ThreadShell = {
        ...thread,
        latestRunId: RunId.make("run:completed"),
        latestRunCompletedAt: now,
        activeRunId: null,
        status: "completed",
        lastErrorClass: null,
        usageLimitResetAt: null,
        pendingRuntimeRequest: null,
        latestVisibleMessage: null,
        latestUserMessageAt: now,
        hasActionableProposedPlan: false,
        itemCount: 1,
        visibleItemCount: 1,
      };
      const terminal: TerminalSummary = {
        threadId: scenario === "other-thread" ? "another-thread" : threadId,
        terminalId: "terminal",
        cwd: process.cwd(),
        worktreePath: null,
        status: "running",
        pid: 123,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: scenario !== "idle",
        label: "shell",
        updatedAt: DateTime.formatIso(now),
      };
      const received = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      let metadata: ((event: TerminalMetadataStreamEvent) => Effect.Effect<void>) | undefined;
      let unsubscribed = false;
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getContinuousRecoveryThreads: Effect.succeed([thread]),
          getThreadShell: () => Effect.succeed(shell),
          getLimitRecoveryCandidates: () => Effect.succeed([]),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Queue.offer(received, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          subscribeMetadata: (listener) =>
            Effect.gen(function* () {
              metadata = listener;
              yield* listener({ type: "snapshot", terminals: [terminal] });
              return () => {
                unsubscribed = true;
              };
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const initial = yield* Queue.take(received);
        assert.equal(initial.type, "thread.continuation.check");
        if (initial.type !== "thread.continuation.check") return;
        assert.equal(initial.requestId, thread.continuousRecovery!.requestId);
        assert.equal(initial.attempt, 3);
        assert.equal(initial.hasRunningConsole, scenario === "busy");
        yield* metadata!({
          type: "upsert",
          terminal: {
            ...terminal,
            threadId,
            hasRunningSubprocess: true,
          },
        });
        yield* TestClock.adjust("5 seconds");
        const running = yield* Queue.take(received);
        assert.equal(
          running.type === "thread.continuation.check" && running.hasRunningConsole,
          true,
        );
        yield* metadata!({ type: "remove", threadId, terminalId: terminal.terminalId });
        yield* TestClock.adjust("5 seconds");
        const closed = yield* Queue.take(received);
        assert.equal(
          closed.type === "thread.continuation.check" && closed.hasRunningConsole,
          false,
        );
      }).pipe(
        Effect.provide(
          UsageLimitRecoveryWorker.layer.pipe(
            Layer.provide(dependencies),
            Layer.provide(Scheduler.layer),
          ),
        ),
      );
      assert.isTrue(unsubscribed);
    }),
);
