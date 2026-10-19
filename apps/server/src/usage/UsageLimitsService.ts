import {
  type ProviderUsageLimitsMcpInput,
  type ProviderUsageLimitsMcpResult,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

export class UsageLimitsService extends Context.Service<
  UsageLimitsService,
  {
    readonly read: (
      input?: ProviderUsageLimitsMcpInput,
    ) => Effect.Effect<ProviderUsageLimitsMcpResult>;
  }
>()("t3/usage/UsageLimitsService") {}

const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;

  /**
   * Background refreshes only run while a client is in the foreground, and
   * OpenCode never refreshes on an interval, so an unattended agent re-checks
   * what is stale itself. Only quota a provider can report is re-checked.
   */
  const refreshStale = Effect.fn("UsageLimitsService.refreshStale")(function* (
    maxAgeSeconds: number,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const stale = (checkedAt: string) => now - Date.parse(checkedAt) > maxAgeSeconds * 1000;
    const staleInstances = (yield* providers.getProviders).filter(
      (provider) =>
        provider.enabled &&
        provider.usageLimits !== undefined &&
        provider.usageLimits.unavailable?.reason !== "unsupported" &&
        stale(provider.usageLimits.checkedAt),
    );
    const staleSources = (yield* sources.current).some((source) => stale(source.checkedAt));
    yield* Effect.all(
      [
        Effect.forEach(
          staleInstances,
          (provider) => providers.refreshInstance(provider.instanceId),
          {
            concurrency: "unbounded",
            discard: true,
          },
        ),
        staleSources ? sources.refresh : Effect.void,
      ],
      { concurrency: "unbounded", discard: true },
    );
  });

  const read = Effect.fn("UsageLimitsService.read")(function* (
    input?: ProviderUsageLimitsMcpInput,
  ) {
    if (input?.maxAgeSeconds !== undefined) yield* refreshStale(input.maxAgeSeconds);
    const readAt = DateTime.formatIso(yield* DateTime.now);
    const ageSeconds = (checkedAt: string) =>
      Math.max(0, (Date.parse(readAt) - Date.parse(checkedAt)) / 1000);
    const quota = (
      limits: ServerProviderUsageLimits | undefined,
    ): ProviderUsageLimitsMcpResult["providers"][number]["quota"] => ({
      status:
        limits === undefined
          ? "notReported"
          : limits.unavailable?.reason === "probeFailed"
            ? "error"
            : limits.unavailable
              ? "unavailable"
              : "available",
      ...(limits === undefined
        ? {}
        : { checkedAt: limits.checkedAt, ageSeconds: ageSeconds(limits.checkedAt) }),
      // Project fields explicitly: provider diagnostics and credential identities never leave this read.
      windows: (limits?.windows ?? []).map((window) => ({
        id: window.id,
        kind: window.kind,
        label: window.label,
        usedPercent: window.usedPercent,
        remainingPercent: 100 - window.usedPercent,
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        ...(window.windowDurationMins === undefined
          ? {}
          : { windowDurationMins: window.windowDurationMins }),
      })),
    });
    return {
      readAt,
      providers: (yield* providers.getProviders).map((provider) => ({
        instanceId: provider.instanceId,
        driver: provider.driver,
        enabled: provider.enabled,
        quota: quota(provider.usageLimits),
      })),
      sources: (yield* sources.current).map((source) => ({
        sourceId: source.id,
        status: source.error === undefined ? ("available" as const) : ("error" as const),
        checkedAt: source.checkedAt,
        ageSeconds: ageSeconds(source.checkedAt),
        accounts: source.accounts.map((account) => ({
          accountId: account.id,
          driver: account.driver,
          quota: quota(account.usageLimits),
        })),
      })),
    };
  });
  return UsageLimitsService.of({ read });
});

export const layer = Layer.effect(UsageLimitsService, make);
