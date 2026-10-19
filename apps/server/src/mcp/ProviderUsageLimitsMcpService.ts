import {
  OrchestratorMcpFailure,
  type ProviderUsageLimitsMcpInput,
  type ProviderUsageLimitsMcpResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitsService from "../usage/UsageLimitsService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { readCaller } from "./threadAccess.ts";

export class ProviderUsageLimitsMcpService extends Context.Service<
  ProviderUsageLimitsMcpService,
  {
    readonly read: (
      input: ProviderUsageLimitsMcpInput,
    ) => Effect.Effect<
      ProviderUsageLimitsMcpResult,
      OrchestratorMcpFailure,
      McpInvocationContext.McpInvocationContext | ThreadManagementService.ThreadManagementService
    >;
  }
>()("t3/mcp/ProviderUsageLimitsMcpService") {}

const make = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const usageLimits = yield* UsageLimitsService.UsageLimitsService;
  const read = Effect.fn("ProviderUsageLimitsMcpService.read")(function* (
    input: ProviderUsageLimitsMcpInput,
  ) {
    const caller = yield* readCaller();
    const descriptor = yield* environment.getDescriptor;
    if (descriptor.environmentId !== caller.scope.environmentId)
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This credential belongs to another environment.",
      });
    return yield* usageLimits.read(input);
  });
  return ProviderUsageLimitsMcpService.of({ read });
});

export const layer = Layer.effect(ProviderUsageLimitsMcpService, make);
