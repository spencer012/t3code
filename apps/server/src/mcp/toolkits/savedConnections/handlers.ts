import * as Effect from "effect/Effect";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as SavedConnectionRequests from "../../SavedConnectionRequests.ts";
import { SavedConnectionsToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(SavedConnectionsToolkit, {
  t3_saved_connection_add: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const requests = yield* SavedConnectionRequests.SavedConnectionRequests;
      return yield* requests.request(scope, { ...input, operation: "add" });
    }),
  ),
  t3_saved_connection_remove: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const requests = yield* SavedConnectionRequests.SavedConnectionRequests;
      return yield* requests.request(scope, { ...input, operation: "remove" });
    }),
  ),
});
