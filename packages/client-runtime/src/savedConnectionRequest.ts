import {
  SAVED_CONNECTION_FAILURE_MESSAGES,
  type EnvironmentId,
  type SavedConnectionRequestResult,
  type SavedConnectionRespondInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ConnectionOnboarding from "./connection/onboarding.ts";
import * as EnvironmentRegistry from "./connection/registry.ts";
import { connectionRoutes } from "./connection/routes.ts";
import type { ConnectionCatalogEntry } from "./connection/catalog.ts";

type Outcome = Extract<SavedConnectionRespondInput["answer"], { type: "complete" }>["outcome"];

export function savedConnectionMatches(
  card: SavedConnectionRequestResult,
  entry: ConnectionCatalogEntry,
) {
  if (entry.target._tag === "PrimaryConnectionTarget") return false;
  if (
    card.targetEnvironmentId !== undefined &&
    entry.target.environmentId !== card.targetEnvironmentId
  )
    return false;
  if (
    card.targetLabel !== undefined &&
    entry.target.label.toLowerCase() !== card.targetLabel.toLowerCase()
  )
    return false;
  if (
    card.host !== undefined &&
    !connectionRoutes(entry).some((route) => {
      const profile = Option.getOrNull(route.profile);
      return (
        profile?._tag === "BearerConnectionProfile" &&
        new URL(profile.httpBaseUrl).host.toLowerCase() === card.host!.toLowerCase()
      );
    })
  )
    return false;
  return true;
}

/** Only outcomes cross back to the asking server. Never forward exception text or credentials. */
export const executeSavedConnectionRequest = Effect.fnUntraced(function* (
  card: SavedConnectionRequestResult,
  pairingUrl?: string,
  sourceEnvironmentId?: EnvironmentId,
): Effect.fn.Return<
  Outcome,
  never,
  ConnectionOnboarding.ConnectionOnboarding | EnvironmentRegistry.EnvironmentRegistry
> {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  if (card.operation === "add") {
    if (pairingUrl === undefined) return { type: "failed", reason: "unavailable" };
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    return yield* onboarding
      .registerPairing({
        pairingUrl,
        ...(card.targetLabel === undefined ? {} : { label: card.targetLabel }),
      })
      .pipe(
        Effect.flatMap((environmentId) =>
          SubscriptionRef.get(registry.entries).pipe(
            Effect.map((entries): Outcome => ({
              type: "success",
              environmentId,
              label: entries.get(environmentId)?.target.label ?? card.label,
            })),
          ),
        ),
        Effect.catch((error) =>
          Effect.succeed<Outcome>({
            type: "failed",
            reason:
              error._tag === "ConnectionBlockedError" && error.reason === "authentication"
                ? "expired"
                : "client_failed",
          }),
        ),
      );
  }
  const matches = [...(yield* SubscriptionRef.get(registry.entries)).values()].filter((entry) =>
    savedConnectionMatches(card, entry),
  );
  if (matches.length !== 1)
    return { type: "failed", reason: matches.length === 0 ? "not_found" : "ambiguous" };
  const target = matches[0]!.target;
  if (target.environmentId === sourceEnvironmentId)
    return { type: "failed", reason: "source_environment" };
  return yield* registry.remove(target.environmentId).pipe(
    Effect.as<Outcome>({
      type: "success",
      environmentId: target.environmentId,
      label: target.label,
    }),
    Effect.catch(() => Effect.succeed<Outcome>({ type: "failed", reason: "client_failed" })),
  );
});

export function savedConnectionOutcomeText(card: SavedConnectionRequestResult) {
  switch (card.connectionStatus) {
    case "pending":
      return `${card.operation === "add" ? "Add" : "Remove"} ${card.label}${card.operation === "add" && card.host !== undefined && card.label !== card.host ? ` (${card.host})` : ""} ${card.operation === "add" ? "to" : "from"} this app?`;
    case "claimed":
      return "Another window is handling this saved connection request.";
    case "added":
      return `Added ${card.resultLabel ?? card.label} in the app that answered.`;
    case "removed":
      return `Removed ${card.resultLabel ?? card.label} in the app that answered.`;
    case "declined":
      return `Declined to ${card.operation} ${card.label}.`;
    case "failed":
      return SAVED_CONNECTION_FAILURE_MESSAGES[card.failure ?? "client_failed"];
  }
}
