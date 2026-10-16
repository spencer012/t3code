import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

export const SavedConnectionStatus = Schema.Literals([
  "pending",
  "claimed",
  "added",
  "removed",
  "declined",
  "failed",
]);
export const SavedConnectionFailure = Schema.Literals([
  "expired",
  "unavailable",
  "not_found",
  "ambiguous",
  "client_failed",
  "interrupted",
  "source_environment",
]);
export const SAVED_CONNECTION_FAILURE_MESSAGES = {
  source_environment:
    "This connection hosts the requesting thread. Ask from another environment before removing it, so the agent can receive the result.",
  expired: "Pairing link expired, mint a new one.",
  unavailable:
    "The request expired or its server restarted. Create a new request and pairing link.",
  not_found: "No matching saved connection exists in this app.",
  ambiguous: "Several saved connections match. Retry with an environment id.",
  client_failed:
    "The app could not save the connection. Check its address, availability, and permissions.",
  interrupted: "The app did not confirm completion. Check saved connections before retrying.",
} as const;

/** Deliberately contains no URL, token, or client-supplied error text. */
export const SavedConnectionRequestFields = {
  operation: Schema.Literals(["add", "remove"]),
  label: TrimmedNonEmptyString,
  host: Schema.optional(TrimmedNonEmptyString),
  targetEnvironmentId: Schema.optional(EnvironmentId),
  targetLabel: Schema.optional(TrimmedNonEmptyString),
  connectionStatus: SavedConnectionStatus,
  resultEnvironmentId: Schema.optional(EnvironmentId),
  resultLabel: Schema.optional(TrimmedNonEmptyString),
  failure: Schema.optional(SavedConnectionFailure),
} as const;

export const SavedConnectionRequestResult = Schema.Struct({
  turnItemId: TurnItemId,
  ...SavedConnectionRequestFields,
});
export type SavedConnectionRequestResult = typeof SavedConnectionRequestResult.Type;

export const SavedConnectionRequestInput = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("add"),
    pairingUrl: TrimmedNonEmptyString,
    label: Schema.optional(TrimmedNonEmptyString),
    clientRequestId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    operation: Schema.Literal("remove"),
    environmentId: Schema.optional(EnvironmentId),
    label: Schema.optional(TrimmedNonEmptyString),
    host: Schema.optional(TrimmedNonEmptyString),
    clientRequestId: TrimmedNonEmptyString,
  }),
]);
export type SavedConnectionRequestInput = typeof SavedConnectionRequestInput.Type;

export const SavedConnectionRespondInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("decline") }),
    Schema.Struct({ type: Schema.Literal("claim"), claimId: TrimmedNonEmptyString }),
    Schema.Struct({
      type: Schema.Literal("complete"),
      claimId: TrimmedNonEmptyString,
      outcome: Schema.Union([
        Schema.Struct({
          type: Schema.Literal("success"),
          environmentId: EnvironmentId,
          label: TrimmedNonEmptyString,
        }),
        Schema.Struct({ type: Schema.Literal("failed"), reason: SavedConnectionFailure }),
      ]),
    }),
  ]),
});
export type SavedConnectionRespondInput = typeof SavedConnectionRespondInput.Type;

/** A claim response is ephemeral RPC data, never an orchestration payload. */
export const SavedConnectionRespondResult = Schema.Struct({
  request: SavedConnectionRequestResult,
  pairingUrl: Schema.optional(Schema.String),
});
export type SavedConnectionRespondResult = typeof SavedConnectionRespondResult.Type;

export class SavedConnectionRequestError extends Schema.TaggedError<SavedConnectionRequestError>()(
  "SavedConnectionRequestError",
  { reason: Schema.Literals(["not_found", "already_claimed", "record_failed", "invalid_answer"]) },
) {
  override get message() {
    return "Could not answer this saved connection request. Refresh the thread and try again.";
  }
}
