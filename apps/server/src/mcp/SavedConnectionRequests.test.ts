import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type SavedConnectionRequestInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SavedConnectionRequests from "./SavedConnectionRequests.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as Handlers from "./toolkits/savedConnections/handlers.ts";
import { SavedConnectionsToolkit } from "./toolkits/savedConnections/tools.ts";

const threadId = ThreadId.make("saved-connection-test");
const instanceId = ProviderInstanceId.make("codex");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("local"),
  requestNamespace: "saved-test",
  thread: { threadId, providerSessionId: "saved-test", providerInstanceId: instanceId },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Tests do not start a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = Sqlite.layerMemory;
const orchestration = ThreadManagement.layer.pipe(
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "saved-connections" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: database, runEffectWorker: false },
      ),
    ),
  ),
);
const testLayer = SavedConnectionRequests.layer.pipe(Layer.provideMerge(orchestration));
const secret = "single-use-test-pairing-secret";
const input: SavedConnectionRequestInput = {
  operation: "add",
  pairingUrl: `https://foo.test/pair#token=${secret}`,
  label: "foo",
  clientRequestId: "foo",
};
const setup = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("saved-test"),
    title: "Connections",
    modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("send"),
    threadId,
    messageId: MessageId.make("initial"),
    text: "Set up foo",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return {
    orchestrator,
    requests: yield* SavedConnectionRequests.SavedConnectionRequests,
    projections: yield* ProjectionStore.ProjectionStoreV2,
  };
});

describe("SavedConnectionRequests", () => {
  it.effect(
    "returns at once, deduplicates concurrent retries, and notifies once after the turn ends",
    () =>
      Effect.gen(function* () {
        const { orchestrator, requests, projections } = yield* setup;
        const [first, retry] = yield* Effect.all(
          [requests.request(invocation, input), requests.request(invocation, input)],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(first, retry);
        assert.equal(first.connectionStatus, "pending");
        let projection = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(
          projection.turnItems.filter((item) => item.type === "saved_connection_request"),
          1,
        );
        const run = projection.runs[0]!;
        const now = yield* DateTime.now;
        yield* projections.apply({
          id: EventId.make("settled"),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        });
        const claim = {
          threadId,
          turnItemId: first.turnItemId,
          answer: { type: "claim" as const, claimId: "client-a" },
        };
        assert.equal(
          (yield* requests.respond(claim)).pairingUrl,
          input.operation === "add" ? input.pairingUrl : "",
        );
        assert.equal(
          (yield* requests.respond(claim)).pairingUrl,
          input.operation === "add" ? input.pairingUrl : "",
        );
        assert.equal(
          (yield* requests
            .respond({ ...claim, answer: { type: "claim", claimId: "client-b" } })
            .pipe(Effect.flip)).reason,
          "already_claimed",
        );
        const complete = {
          ...claim,
          answer: {
            type: "complete" as const,
            claimId: "client-a",
            outcome: {
              type: "success" as const,
              environmentId: EnvironmentId.make("foo"),
              label: "foo",
            },
          },
        };
        const result = yield* requests.respond(complete);
        assert.equal(result.request.connectionStatus, "added");
        assert.isUndefined(result.pairingUrl);
        yield* requests.respond(complete);
        projection = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(
          projection.messages.filter((message) => message.notification !== undefined),
          1,
        );
        assert.equal(projection.runs.at(-1)?.status, "starting");
        assert.notInclude(JSON.stringify(projection), secret);
        const sql = yield* SqlClient.SqlClient;
        // Includes events, receipts, projections, and queued provider effects.
        for (const table of [
          "orchestration_v2_events",
          "orchestration_v2_projection_turn_items",
          "orchestration_v2_projection_messages",
          "orchestration_v2_effect_outbox",
        ]) {
          const rows = yield* sql.unsafe(`SELECT * FROM ${table}`);
          assert.notInclude(JSON.stringify(rows), secret);
        }
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("declines without exposing the URL and retries return the terminal card", () =>
    Effect.gen(function* () {
      const { orchestrator, requests } = yield* setup;
      const card = yield* requests.request(invocation, input);
      const result = yield* requests.respond({
        threadId,
        turnItemId: card.turnItemId,
        answer: { type: "decline" },
      });
      assert.equal(result.request.connectionStatus, "declined");
      assert.isUndefined(result.pairingUrl);
      assert.equal((yield* requests.request(invocation, input)).connectionStatus, "declined");
      assert.notInclude(JSON.stringify(yield* orchestrator.getThreadProjection(threadId)), secret);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("waitMs returns the answer in the same call instead of notifying", () =>
    Effect.gen(function* () {
      const { orchestrator, requests } = yield* setup;
      const waiting = yield* requests
        .request(invocation, { ...input, waitMs: 60_000 })
        .pipe(Effect.forkChild);
      // Let the waiting call record its card and register before the answer.
      for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
      const card = yield* requests.request(invocation, input);
      assert.equal(card.connectionStatus, "pending");
      yield* requests.respond({
        threadId,
        turnItemId: card.turnItemId,
        answer: { type: "decline" },
      });
      assert.equal((yield* Fiber.join(waiting)).connectionStatus, "declined");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        projection.messages.filter((message) => message.notification !== undefined),
        0,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("waitMs returns pending when the wait ends and notifies the later answer", () =>
    Effect.gen(function* () {
      const { orchestrator, requests } = yield* setup;
      const waiting = yield* requests
        .request(invocation, { ...input, waitMs: 1_000 })
        .pipe(Effect.forkChild);
      for (let i = 0; i < 100; i++) yield* Effect.yieldNow;
      yield* TestClock.adjust("2 seconds");
      const card = yield* Fiber.join(waiting);
      assert.equal(card.connectionStatus, "pending");
      yield* requests.respond({
        threadId,
        turnItemId: card.turnItemId,
        answer: { type: "decline" },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        projection.messages.filter((message) => message.notification !== undefined),
        1,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("records a clear expired pairing failure and returns no token afterwards", () =>
    Effect.gen(function* () {
      const { requests } = yield* setup;
      const card = yield* requests.request(invocation, input);
      yield* requests.respond({
        threadId,
        turnItemId: card.turnItemId,
        answer: { type: "claim", claimId: "client" },
      });
      const result = yield* requests.respond({
        threadId,
        turnItemId: card.turnItemId,
        answer: {
          type: "complete",
          claimId: "client",
          outcome: { type: "failed", reason: "expired" },
        },
      });
      assert.equal(result.request.failure, "expired");
      assert.isUndefined(
        (yield* requests.respond({
          threadId,
          turnItemId: card.turnItemId,
          answer: { type: "claim", claimId: "client" },
        })).pairingUrl,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("expires pending cards and lost client claims without waiting inside the tool", () =>
    Effect.gen(function* () {
      const { requests } = yield* setup;
      const card = yield* requests.request(invocation, input);
      yield* requests.respond({
        threadId,
        turnItemId: card.turnItemId,
        answer: { type: "claim", claimId: "client" },
      });
      yield* TestClock.adjust("2 minutes");
      assert.equal((yield* requests.request(invocation, input)).failure, "interrupted");
      const pending = yield* requests.request(invocation, { ...input, clientRequestId: "expires" });
      yield* TestClock.adjust("15 minutes");
      assert.equal(
        (yield* requests.respond({
          threadId,
          turnItemId: pending.turnItemId,
          answer: { type: "claim", claimId: "late" },
        })).request.failure,
        "unavailable",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("refuses outside OAuth clients, inactive threads, plan mode, and limited access", () =>
    Effect.gen(function* () {
      const { requests, orchestrator } = yield* setup;
      const outside = {
        ...invocation,
        thread: undefined,
        client: { sessionId: "oauth", label: "Outside", access: "full-access" as const },
      };
      assert.equal(
        (yield* requests.request(outside, input).pipe(Effect.flip)).code,
        "thread_credential_required",
      );
      for (const mode of [
        { runtimeMode: "approval-required" as const },
        { interactionMode: "plan" as const },
      ]) {
        yield* orchestrator.dispatch({
          type: "runtimeMode" in mode ? "thread.runtime-mode.set" : "thread.interaction-mode.set",
          commandId: CommandId.make(JSON.stringify(mode)),
          threadId,
          ...mode,
        } as import("@t3tools/contracts").OrchestrationV2ServerCommand);
        assert.equal(
          (yield* requests.request(invocation, input).pipe(Effect.flip)).code,
          "capability_denied",
        );
        yield* orchestrator.dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make(`reset-runtime:${JSON.stringify(mode)}`),
          threadId,
          runtimeMode: "full-access",
        });
        yield* orchestrator.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make(`reset-interaction:${JSON.stringify(mode)}`),
          threadId,
          interactionMode: "default",
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop"),
        threadId,
      });
      assert.equal(
        (yield* requests.request(invocation, input).pipe(Effect.flip)).code,
        "parent_not_active",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes only after a client receipt and reports the environment id", () =>
    Effect.gen(function* () {
      const { requests, orchestrator } = yield* setup;
      const card = yield* requests.request(invocation, {
        operation: "remove",
        environmentId: EnvironmentId.make("foo"),
        clientRequestId: "remove",
      });
      assert.equal(card.connectionStatus, "pending");
      const claimed = yield* requests.respond({
        threadId,
        turnItemId: card.turnItemId,
        answer: { type: "claim", claimId: "client" },
      });
      assert.isUndefined(claimed.pairingUrl);
      const result = yield* requests.respond({
        threadId,
        turnItemId: card.turnItemId,
        answer: {
          type: "complete",
          claimId: "client",
          outcome: { type: "success", environmentId: EnvironmentId.make("foo"), label: "foo" },
        },
      });
      assert.equal(result.request.connectionStatus, "removed");
      assert.equal(result.request.resultEnvironmentId, "foo");
      assert.lengthOf(
        (yield* orchestrator.getThreadProjection(threadId)).messages.filter(
          (message) => message.notification !== undefined,
        ),
        1,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect.each(["thread.stop", "thread.archive"] as const)(
    "%s closes pending cards and a late click never receives the token or wakes the agent",
    (action) =>
      Effect.gen(function* () {
        const { requests, orchestrator } = yield* setup;
        const card = yield* requests.request(invocation, input);
        yield* orchestrator.dispatch({ type: action, commandId: CommandId.make(action), threadId });
        const result = yield* requests.respond({
          threadId,
          turnItemId: card.turnItemId,
          answer: { type: "claim", claimId: "late" },
        });
        assert.equal(result.request.connectionStatus, "failed");
        assert.isUndefined(result.pairingUrl);
        assert.lengthOf(
          (yield* orchestrator.getThreadProjection(threadId)).messages.filter(
            (message) => message.notification !== undefined,
          ),
          0,
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("a restarted service fails old cards without recovering or persisting the token", () =>
    Effect.gen(function* () {
      const { requests } = yield* setup;
      const card = yield* requests.request(invocation, input);
      yield* requests.respond({
        threadId,
        turnItemId: card.turnItemId,
        answer: { type: "claim", claimId: "old-client" },
      });
      const result = yield* SavedConnectionRequests.SavedConnectionRequests.pipe(
        Effect.flatMap((restarted) =>
          restarted.respond({
            threadId,
            turnItemId: card.turnItemId,
            answer: { type: "claim", claimId: "new-client" },
          }),
        ),
        Effect.provide(Layer.fresh(SavedConnectionRequests.layer)),
      );
      assert.equal(result.request.failure, "interrupted");
      assert.isUndefined(result.pairingUrl);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("publishes a pending result through the checked toolkit", () =>
    Effect.gen(function* () {
      yield* setup;
      const toolkit = yield* SavedConnectionsToolkit;
      const response = yield* toolkit
        .handle("t3_saved_connection_add", {
          pairingUrl: `https://foo.test/pair#token=${secret}`,
          label: "foo",
          clientRequestId: "tool",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      assert.equal(response.at(-1)?.isFailure, false);
      // MCP structuredContent must be JSON; undefined fields fail CallToolResult validation.
      const encoded = response.at(-1)?.encodedResult;
      assert.deepStrictEqual(encoded, JSON.parse(JSON.stringify(encoded)));
      assert.notInclude(JSON.stringify(response), secret);
      assert.include(JSON.stringify(response), "pending");
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(testLayer)),
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    ),
  );
});
