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
      "Ask the user to add a single-use pairing URL to THIS CLIENT APP's saved connections. Returns pending immediately with a thread card. The user clicks Add or Decline; an outcome notification then steers the agent or starts a turn. Requires a live full-access/default T3 thread; outside OAuth clients are refused. Never repeat the pairing URL in chat, labels, or clientRequestId. Retry with the same clientRequestId to read the existing card. No remote machine is changed.",
    parameters: Schema.Struct({
      pairingUrl: Schema.String,
      label: Schema.optional(Schema.String),
      clientRequestId: Schema.String,
    }),
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_saved_connection_remove", {
    ...shared,
    description:
      "Ask the user to forget a saved connection and its credential in the app that answers the thread card. Identify it by environmentId and/or exact label or host. Ambiguous matches fail; retry with an id. Returns pending immediately; the outcome arrives as a thread notification. Requires a live full-access/default T3 thread; outside OAuth clients are refused. Never contacts or changes the remote machine. Reuse clientRequestId for retries.",
    parameters: Schema.Struct({
      environmentId: Schema.optional(EnvironmentId),
      label: Schema.optional(Schema.String),
      host: Schema.optional(Schema.String),
      clientRequestId: Schema.String,
    }),
  }).annotate(Tool.Destructive, true),
);
