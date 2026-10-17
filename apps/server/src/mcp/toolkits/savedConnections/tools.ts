import {
  EnvironmentId,
  OrchestratorMcpFailure,
  SavedConnectionRequestResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as SavedConnectionRequests from "../../SavedConnectionRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const waitMs = Schema.optional(
  Schema.Number.annotate({
    description:
      "Optional. Wait up to this many milliseconds (max 120000) for the user to answer the card and return the outcome directly. Without it, or if the wait ends first, the result is pending and the outcome arrives later as a thread notification. Codex sessions may cut off tool calls after about 60 s; use 50000 or less there.",
  }),
);

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  success: SavedConnectionRequestResult,
  dependencies: [
    SavedConnectionRequests.SavedConnectionRequests,
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
export const SavedConnectionsToolkit = Toolkit.make(
  Tool.make("t3_saved_connection_add", {
    ...shared,
    description:
      "Ask the user to add a single-use pairing URL to THIS CLIENT APP's saved connections. Shows a thread card; the user clicks Add or Decline. Returns pending immediately, or pass waitMs to wait for the answer in this call; otherwise the outcome arrives as a notification after your turn. Requires a live full-access/default T3 thread; outside OAuth clients are refused. Never repeat the pairing URL in chat, labels, or clientRequestId. Retry with the same clientRequestId to read the existing card. No remote machine is changed.",
    parameters: Schema.Struct({
      pairingUrl: Schema.String,
      label: Schema.optional(Schema.String),
      clientRequestId: Schema.String,
      waitMs,
    }),
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_saved_connection_remove", {
    ...shared,
    description:
      "Ask the user to forget a saved connection and its credential in the app that answers the thread card. Identify it by environmentId and/or exact label or host. Ambiguous matches fail; retry with an id. Returns pending immediately, or pass waitMs to wait for the answer in this call; otherwise the outcome arrives as a thread notification. Requires a live full-access/default T3 thread; outside OAuth clients are refused. Never contacts or changes the remote machine. Reuse clientRequestId for retries.",
    parameters: Schema.Struct({
      environmentId: Schema.optional(EnvironmentId),
      label: Schema.optional(Schema.String),
      host: Schema.optional(Schema.String),
      clientRequestId: Schema.String,
      waitMs,
    }),
  }).annotate(Tool.Destructive, true),
);
