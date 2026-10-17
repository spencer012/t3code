import * as DateTime from "effect/DateTime";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Stream from "effect/Stream";
import {
  CommandId,
  MessageId,
  TurnItemId,
  OrchestratorMcpFailure,
  SAVED_CONNECTION_FAILURE_MESSAGES,
  SavedConnectionRequestError,
  type OrchestrationV2TurnItem,
  type SavedConnectionRequestInput,
  type SavedConnectionRequestResult,
  type SavedConnectionRespondInput,
  type SavedConnectionRespondResult,
  type ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixed-size ids avoid persisting caller-provided idempotency keys.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { assertFullAccess, assertLiveCaller, readCaller, unavailable } from "./threadAccess.ts";

type Card = Extract<OrchestrationV2TurnItem, { type: "saved_connection_request" }>;
type Memory = { pairingUrl?: string | undefined; claimId?: string | undefined; expiresAt: number };
const TTL_MS = 15 * 60 * 1000;
const CLAIM_TTL_MS = 2 * 60 * 1000;
const MAX_WAIT_MS = 120 * 1000;
const open = (card: Pick<Card, "connectionStatus">) =>
  card.connectionStatus === "pending" || card.connectionStatus === "claimed";
// MCP structuredContent must be JSON, so absent fields are omitted rather than set to undefined.
const resultOf = (card: Card): SavedConnectionRequestResult => ({
  turnItemId: card.id,
  operation: card.operation,
  label: card.label,
  connectionStatus: card.connectionStatus,
  ...(card.host !== undefined ? { host: card.host } : {}),
  ...(card.targetEnvironmentId !== undefined
    ? { targetEnvironmentId: card.targetEnvironmentId }
    : {}),
  ...(card.targetLabel !== undefined ? { targetLabel: card.targetLabel } : {}),
  ...(card.resultEnvironmentId !== undefined
    ? { resultEnvironmentId: card.resultEnvironmentId }
    : {}),
  ...(card.resultLabel !== undefined ? { resultLabel: card.resultLabel } : {}),
  ...(card.failure !== undefined ? { failure: card.failure } : {}),
});

/** Reject URL-shaped display strings so a misplaced pairing URL cannot enter a card. */
function displayLabel(value: string) {
  return (
    value.trim().length > 0 &&
    value.length <= 160 &&
    !/[#?]|:\/\//u.test(value) &&
    !Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}

export class SavedConnectionRequests extends Context.Service<
  SavedConnectionRequests,
  {
    readonly request: (
      scope: McpInvocationContext.McpInvocationScope,
      input: SavedConnectionRequestInput,
    ) => Effect.Effect<SavedConnectionRequestResult, OrchestratorMcpFailure>;
    readonly respond: (
      input: SavedConnectionRespondInput,
    ) => Effect.Effect<SavedConnectionRespondResult, SavedConnectionRequestError>;
  }
>()("t3/mcp/SavedConnectionRequests") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sink = yield* EventSink.EventSinkV2;
  const locks = yield* KeyedLock.make<TurnItemId>();
  const memory = new Map<TurnItemId, Memory>();
  // Tool calls waiting for each card, and outcomes whose notification they replaced.
  const waiters = new Map<TurnItemId, number>();
  const owedWakes = new Set<TurnItemId>();
  const scope = yield* Effect.scope;
  yield* Effect.addFinalizer(() => Effect.sync(() => memory.clear()));

  // Drop secrets as soon as Stop/archive closes a card, without retaining a per-thread subscription.
  const afterSequence = yield* sink.latestSequence().pipe(Effect.orDie);
  yield* sink.stream({ eventType: "turn-item.updated", afterSequence }).pipe(
    Stream.runForEach(({ event }) =>
      Effect.sync(() => {
        if (
          event.type === "turn-item.updated" &&
          event.payload.type === "saved_connection_request" &&
          !open(event.payload)
        )
          memory.delete(event.payload.id);
      }),
    ),
    Effect.catch(() => Effect.logWarning("Saved connection request cleanup stream ended.")),
    Effect.forkScoped,
  );

  const readCard = (threadId: ThreadId, id: TurnItemId) =>
    threads
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["saved_connection_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.map((records) => {
          const item = records.turnItems.find((item) => item.id === id);
          return records.thread.deletedAt === null && item?.type === "saved_connection_request"
            ? item
            : undefined;
        }),
      );

  const record = (card: Card, wake = false, commandSuffix = "") => {
    const result = resultOf(card);
    const description =
      card.connectionStatus === "failed"
        ? SAVED_CONNECTION_FAILURE_MESSAGES[card.failure ?? "client_failed"]
        : card.connectionStatus === "declined"
          ? "The user declined."
          : `${card.connectionStatus === "added" ? "Added" : "Removed"} ${card.resultLabel ?? card.label} (${card.resultEnvironmentId}).`;
    return threads
      .dispatch({
        type: "saved_connection_request.record",
        commandId: CommandId.make(
          `saved-connection:${card.id}:${card.connectionStatus}${commandSuffix}`,
        ),
        threadId: card.threadId,
        runId: card.runId!,
        nodeId: card.nodeId!,
        ...result,
        ...(wake
          ? {
              wake: {
                messageId: MessageId.make(`saved-connection:${card.id}:outcome`),
                text: `Saved connection request ${card.id}: ${description} This action only changes the saved connections in the app that answered the card.`,
                notification: {
                  source: { kind: "background_task" as const },
                  outcome:
                    card.connectionStatus === "failed"
                      ? ("failed" as const)
                      : card.connectionStatus === "declined"
                        ? ("cancelled" as const)
                        : ("completed" as const),
                  summary: description,
                },
              },
            }
          : {}),
      })
      .pipe(Effect.mapError(() => new SavedConnectionRequestError({ reason: "record_failed" })));
  };

  const finish = (card: Card, fields: Partial<SavedConnectionRequestResult>) =>
    Effect.gen(function* () {
      // Delete the secret before recording or waking, including when storage fails.
      memory.delete(card.id);
      const updated = { ...card, ...fields };
      // A waiting tool call returns the outcome itself; notify only if none is waiting.
      const waiting = waiters.has(card.id);
      if (waiting) owedWakes.add(card.id);
      yield* record(updated, !waiting);
      return { request: resultOf(updated) };
    });

  /**
   * Wait (holding no lock) until the card leaves pending/claimed or the time runs out.
   * Registration and the final read with deregistration each take the card lock, like
   * `finish`, so an outcome either reaches this call or is notified. A call that ends
   * without returning it (interrupt, failure) sends the notification it suppressed.
   */
  const awaitOutcome = (threadId: ThreadId, id: TurnItemId, waitMs: number) => {
    let registered = false;
    const leave = (delivered: boolean) =>
      Effect.gen(function* () {
        if (!registered) return;
        registered = false;
        const left = (waiters.get(id) ?? 1) - 1;
        if (left > 0) {
          waiters.set(id, left);
          return;
        }
        waiters.delete(id);
        if (!owedWakes.delete(id) || delivered) return;
        const card = yield* readCard(threadId, id);
        if (card !== undefined) yield* record(card, true, ":wake");
      });
    return Effect.gen(function* () {
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      yield* locks.withLock(
        id,
        Effect.sync(() => {
          waiters.set(id, (waiters.get(id) ?? 0) + 1);
          registered = true;
        }),
      );
      const settled = (card: Card | undefined) => card === undefined || !open(card);
      yield* Effect.gen(function* () {
        if (settled(yield* readCard(threadId, id))) return;
        yield* threads
          .streamStoredEventsFrom({ threadId, afterSequence, eventType: "turn-item.updated" })
          .pipe(
            Stream.mapEffect(() => readCard(threadId, id)),
            Stream.filter(settled),
            Stream.runHead,
          );
      }).pipe(Effect.timeoutOption(Duration.millis(waitMs)));
      return yield* locks.withLock(
        id,
        Effect.gen(function* () {
          const card = yield* readCard(threadId, id);
          yield* leave(card !== undefined && !open(card));
          return card;
        }),
      );
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : locks
              .withLock(id, leave(false))
              .pipe(
                Effect.catch(() =>
                  Effect.logWarning("Could not notify a saved connection outcome."),
                ),
              ),
      ),
    );
  };

  const request: SavedConnectionRequests["Service"]["request"] = (invocation, input) =>
    Effect.gen(function* () {
      const threadScope = yield* McpInvocationContext.requireThreadScope(
        invocation,
        "Saved connection requests",
      );
      const threadId = threadScope.thread.threadId;
      const id = TurnItemId.make(
        `saved-connection:${NodeCrypto.createHash("sha256")
          .update(
            `${threadId.length}:${threadId}${invocation.requestNamespace.length}:${invocation.requestNamespace}${input.clientRequestId.length}:${input.clientRequestId}`,
          )
          .digest("hex")}`,
      );
      const result = yield* locks.withLock(
        id,
        Effect.gen(function* () {
          const caller = yield* readCaller().pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(ThreadManagement.ThreadManagementService, threads),
          );
          yield* assertLiveCaller(caller);
          yield* assertFullAccess(
            caller,
            "Saved connection requests require a live full-access/default calling thread.",
          );
          const existing = yield* readCard(threadId, id).pipe(Effect.mapError(unavailable));
          if (existing !== undefined) return resultOf(existing);
          if (
            input.clientRequestId.trim().length === 0 ||
            input.clientRequestId.length > 200 ||
            (input.operation === "remove" &&
              input.environmentId !== undefined &&
              !displayLabel(input.environmentId)) ||
            (input.label !== undefined && !displayLabel(input.label))
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "Use a short label and clientRequestId. Do not put URLs or secrets in display fields.",
            });
          let host: string | undefined;
          let pairingUrl: string | undefined;
          if (input.operation === "add") {
            const parsed = yield* Effect.try({
              try: () => new URL(input.pairingUrl),
              catch: unavailable,
            });
            const token = new URLSearchParams(parsed.hash.slice(1));
            if (
              !["http:", "https:"].includes(parsed.protocol) ||
              parsed.username ||
              parsed.password ||
              parsed.pathname !== "/pair" ||
              parsed.search ||
              !token.get("token") ||
              [...token.keys()].some((key) => key !== "token") ||
              token.getAll("token").length !== 1 ||
              input.pairingUrl.length > 8192
            )
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "Pass an HTTP(S) /pair#token=... single-use pairing URL.",
              });
            host = parsed.host;
            pairingUrl = parsed.href;
          } else {
            if (
              input.environmentId === undefined &&
              input.label === undefined &&
              input.host === undefined
            )
              return yield* new OrchestratorMcpFailure({
                code: "target_required",
                message: "Pass environmentId, label, or host to identify the saved connection.",
              });
            if (input.host !== undefined) {
              const parsed = yield* Effect.try({
                try: () => new URL(`http://${input.host}`),
                catch: unavailable,
              });
              if (
                parsed.host !== input.host ||
                parsed.pathname !== "/" ||
                parsed.username ||
                parsed.password ||
                parsed.search ||
                parsed.hash
              )
                return yield* new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: "Pass only the host name and optional port.",
                });
              host = parsed.host;
            }
          }
          if (memory.size >= 1000)
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "Too many pending saved connection requests. Answer or wait for existing cards to expire.",
            });
          const parent = yield* threads
            .getThreadRecords(threadId, ["runs"], { messageRoles: [] })
            .pipe(Effect.mapError(unavailable));
          const run = ThreadManagement.latestActiveRun(parent);
          if (
            run === undefined ||
            run.rootNodeId === null ||
            run.providerInstanceId !== threadScope.thread.providerInstanceId
          )
            return yield* new OrchestratorMcpFailure({
              code: "parent_not_active",
              message: "The calling provider no longer owns an active run.",
            });
          const now = yield* Clock.currentTimeMillis;
          const updatedAt = yield* DateTime.now;
          const card: Card = {
            id,
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "waiting",
            title: input.label ?? host ?? "Saved connection",
            startedAt: null,
            completedAt: null,
            updatedAt,
            type: "saved_connection_request",
            operation: input.operation,
            label:
              input.label ??
              host ??
              (input.operation === "remove" ? input.environmentId! : "Environment"),
            host,
            targetLabel: input.label,
            targetEnvironmentId: input.operation === "remove" ? input.environmentId : undefined,
            connectionStatus: "pending",
          };
          memory.set(id, { pairingUrl, expiresAt: now + TTL_MS });
          yield* record(card).pipe(
            Effect.tapError(() => Effect.sync(() => memory.delete(id))),
            Effect.mapError(unavailable),
          );
          // Scoped timers hold no token. A disconnect leaves the card answerable until its deadline.
          yield* Effect.sleep(TTL_MS).pipe(
            Effect.andThen(
              locks.withLock(
                id,
                Effect.gen(function* () {
                  const current = yield* readCard(threadId, id);
                  if (current !== undefined && open(current))
                    yield* finish(current, {
                      connectionStatus: "failed",
                      failure:
                        current.connectionStatus === "claimed" ? "interrupted" : "unavailable",
                    });
                  memory.delete(id);
                }),
              ),
            ),
            Effect.catch(() => Effect.sync(() => memory.delete(id))),
            Effect.forkIn(scope),
          );
          return resultOf(card);
        }),
      );
      const waitMs =
        input.waitMs !== undefined && Number.isFinite(input.waitMs)
          ? Math.min(MAX_WAIT_MS, Math.max(0, Math.floor(input.waitMs)))
          : 0;
      if (waitMs === 0 || !open(result)) return result;
      const settled = yield* awaitOutcome(threadId, id, waitMs).pipe(Effect.mapError(unavailable));
      return settled === undefined ? result : resultOf(settled);
    });

  const respond: SavedConnectionRequests["Service"]["respond"] = (input) =>
    locks.withLock(
      input.turnItemId,
      Effect.gen(function* () {
        const card = yield* readCard(input.threadId, input.turnItemId).pipe(
          Effect.mapError(() => new SavedConnectionRequestError({ reason: "not_found" })),
        );
        if (card === undefined || card.runId === null || card.nodeId === null)
          return yield* new SavedConnectionRequestError({ reason: "not_found" });
        if (!open(card)) {
          memory.delete(card.id);
          return { request: resultOf(card) };
        }
        const entry = memory.get(card.id);
        const now = yield* Clock.currentTimeMillis;
        if (input.answer.type === "decline") {
          if (card.connectionStatus === "claimed")
            return yield* new SavedConnectionRequestError({ reason: "already_claimed" });
          return yield* finish(card, { connectionStatus: "declined" });
        }
        if (entry === undefined || entry.expiresAt <= now)
          return yield* finish(card, {
            connectionStatus: "failed",
            failure: card.connectionStatus === "claimed" ? "interrupted" : "unavailable",
          });
        if (input.answer.type === "claim") {
          if (card.connectionStatus === "claimed" && entry.claimId !== input.answer.claimId)
            return yield* new SavedConnectionRequestError({ reason: "already_claimed" });
          if (card.connectionStatus === "claimed")
            return {
              request: resultOf(card),
              ...(entry.pairingUrl === undefined ? {} : { pairingUrl: entry.pairingUrl }),
            };
          const updated: Card = { ...card, connectionStatus: "claimed" };
          yield* record(updated);
          const recorded = yield* readCard(input.threadId, card.id).pipe(
            Effect.mapError(() => new SavedConnectionRequestError({ reason: "record_failed" })),
          );
          if (recorded === undefined || !open(recorded)) {
            memory.delete(card.id);
            return {
              request: resultOf(
                recorded ?? { ...card, connectionStatus: "failed", failure: "unavailable" },
              ),
            };
          }
          entry.claimId = input.answer.claimId;
          entry.expiresAt = now + CLAIM_TTL_MS;
          const pairingUrl = entry.pairingUrl;
          // Keep it for idempotent claim retries until completion or the short lease expires.
          yield* Effect.sleep(CLAIM_TTL_MS).pipe(
            Effect.andThen(
              locks.withLock(
                card.id,
                Effect.gen(function* () {
                  const current = yield* readCard(input.threadId, card.id);
                  if (current !== undefined && open(current))
                    yield* finish(current, { connectionStatus: "failed", failure: "interrupted" });
                }),
              ),
            ),
            Effect.catch(() => Effect.sync(() => memory.delete(card.id))),
            Effect.forkIn(scope),
          );
          return {
            request: resultOf(updated),
            ...(pairingUrl === undefined ? {} : { pairingUrl }),
          };
        }
        if (card.connectionStatus !== "claimed" || entry.claimId !== input.answer.claimId)
          return yield* new SavedConnectionRequestError({ reason: "invalid_answer" });
        const outcome = input.answer.outcome;
        if (outcome.type === "success") {
          if (
            !displayLabel(outcome.label) ||
            !displayLabel(outcome.environmentId) ||
            (card.operation === "remove" &&
              card.targetEnvironmentId !== undefined &&
              outcome.environmentId !== card.targetEnvironmentId)
          )
            return yield* new SavedConnectionRequestError({ reason: "invalid_answer" });
          return yield* finish(card, {
            connectionStatus: card.operation === "add" ? "added" : "removed",
            resultEnvironmentId: outcome.environmentId,
            resultLabel: outcome.label,
          });
        }
        return yield* finish(card, { connectionStatus: "failed", failure: outcome.reason });
      }),
    );
  return SavedConnectionRequests.of({ request, respond });
});
export const layer = Layer.effect(SavedConnectionRequests, make);
