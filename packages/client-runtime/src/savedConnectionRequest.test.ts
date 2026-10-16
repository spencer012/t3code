import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, TurnItemId, type SavedConnectionRequestResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./connection/catalog.ts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  ConnectionBlockedError,
} from "./connection/model.ts";
import * as EnvironmentRegistry from "./connection/registry.ts";
import * as ConnectionOnboarding from "./connection/onboarding.ts";
import {
  executeSavedConnectionRequest,
  savedConnectionMatches,
  savedConnectionOutcomeText,
} from "./savedConnectionRequest.ts";

const foo = EnvironmentId.make("foo");
const card: SavedConnectionRequestResult = {
  turnItemId: TurnItemId.make("card"),
  operation: "remove",
  label: "foo",
  targetLabel: "foo",
  connectionStatus: "claimed",
};
const entry = (id = foo, label = "foo", host = "foo.test"): ConnectionCatalogEntry => ({
  target: new BearerConnectionTarget({ environmentId: id, label, connectionId: id }),
  profile: Option.some(
    new BearerConnectionProfile({
      environmentId: id,
      label,
      connectionId: id,
      httpBaseUrl: `https://${host}`,
      wsBaseUrl: `wss://${host}`,
    }),
  ),
  enabled: false,
});
const primary: ConnectionCatalogEntry = {
  target: new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("primary"),
    label: "foo",
    httpBaseUrl: "http://localhost",
    wsBaseUrl: "ws://localhost",
  }),
  profile: Option.none(),
  enabled: true,
};

describe("saved connection actions", () => {
  it("matches exact ids, labels, and hosts together, including disabled entries", () => {
    assert.isTrue(savedConnectionMatches(card, entry()));
    assert.isFalse(savedConnectionMatches(card, primary));
    assert.isFalse(
      savedConnectionMatches(
        { ...card, targetEnvironmentId: EnvironmentId.make("other") },
        entry(),
      ),
    );
    assert.isFalse(savedConnectionMatches({ ...card, targetLabel: "fo" }, entry()));
    assert.isFalse(savedConnectionMatches({ ...card, host: "foo.test:8443" }, entry()));
    assert.isTrue(
      savedConnectionMatches({ ...card, targetLabel: "FOO", host: "FOO.test" }, entry()),
    );
  });

  it.effect("refuses ambiguous targets and removes only the exact selected saved connection", () =>
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(
        new Map([
          [foo, entry()],
          [EnvironmentId.make("other"), entry(EnvironmentId.make("other"))],
          [primary.target.environmentId, primary],
        ]),
      );
      const removed: EnvironmentId[] = [];
      const networkStatus = yield* SubscriptionRef.make<"online" | "offline" | "unknown">("online");
      const layer = Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({
        entries,
        networkStatus,
        remove: (id) =>
          Effect.sync(() => {
            removed.push(id);
          }),
      });
      const ambiguous = yield* executeSavedConnectionRequest(card).pipe(Effect.provide(layer));
      assert.deepEqual(ambiguous, { type: "failed", reason: "ambiguous" });
      assert.lengthOf(removed, 0);
      const result = yield* executeSavedConnectionRequest({
        ...card,
        targetEnvironmentId: foo,
      }).pipe(Effect.provide(layer));
      assert.deepEqual(result, { type: "success", environmentId: foo, label: "foo" });
      assert.deepEqual(removed, [foo]);
      assert.deepEqual(
        yield* executeSavedConnectionRequest({ ...card, targetLabel: "missing" }).pipe(
          Effect.provide(layer),
        ),
        { type: "failed", reason: "not_found" },
      );
      assert.deepEqual(
        yield* executeSavedConnectionRequest(
          { ...card, targetEnvironmentId: foo },
          undefined,
          foo,
        ).pipe(Effect.provide(layer)),
        { type: "failed", reason: "source_environment" },
      );
      assert.deepEqual(removed, [foo]);
    }).pipe(Effect.provide(Layer.mock(ConnectionOnboarding.ConnectionOnboarding)({}))),
  );

  it.effect("reports the saved label after pairing, including when no label was supplied", () =>
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map([[foo, entry(foo, "Remote descriptor label")]]));
      const networkStatus = yield* SubscriptionRef.make<"online" | "offline" | "unknown">("online");
      const layer = Layer.mergeAll(
        Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({ entries, networkStatus }),
        Layer.mock(ConnectionOnboarding.ConnectionOnboarding)({
          registerPairing: () => Effect.succeed(foo),
        }),
      );
      const result = yield* executeSavedConnectionRequest(
        {
          turnItemId: card.turnItemId,
          operation: "add",
          label: "foo.test",
          connectionStatus: "claimed",
        },
        "https://foo.test/pair#token=once",
      ).pipe(Effect.provide(layer));
      assert.deepEqual(result, {
        type: "success",
        environmentId: foo,
        label: "Remote descriptor label",
      });
    }),
  );

  it.effect("reports expired credentials without copying an error or URL into its outcome", () =>
    Effect.gen(function* () {
      const secret = "do-not-report-this-pairing-token";
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map());
      const networkStatus = yield* SubscriptionRef.make<"online" | "offline" | "unknown">("online");
      const outcome = yield* executeSavedConnectionRequest(
        { ...card, operation: "add" },
        `https://foo.test/pair#token=${secret}`,
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(EnvironmentRegistry.EnvironmentRegistry)({ entries, networkStatus }),
            Layer.mock(ConnectionOnboarding.ConnectionOnboarding)({
              registerPairing: () =>
                Effect.fail(
                  new ConnectionBlockedError({ reason: "authentication", detail: secret }),
                ),
            }),
          ),
        ),
      );
      assert.deepEqual(outcome, { type: "failed", reason: "expired" });
      assert.notInclude(JSON.stringify(outcome), secret);
      assert.include(
        savedConnectionOutcomeText({ ...card, connectionStatus: "failed", failure: "expired" }),
        "mint a new one",
      );
    }),
  );
});
