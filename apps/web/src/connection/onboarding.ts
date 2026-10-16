import { executeSavedConnectionRequest } from "@t3tools/client-runtime/saved-connection-request";
import type { EnvironmentId, SavedConnectionRequestResult } from "@t3tools/contracts";
import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "./runtime";

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: ConnectionOnboarding.PairingConnectionInput) => JSON.stringify(input),
  },
  execute: (input: ConnectionOnboarding.PairingConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
    ),
});

// Never key or log this command by its URL: it contains the one-use credential.
export const executeSavedConnection = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:execute-saved-request",
  execute: (input: {
    request: SavedConnectionRequestResult;
    pairingUrl?: string | undefined;
    sourceEnvironmentId: EnvironmentId;
  }) => executeSavedConnectionRequest(input.request, input.pairingUrl, input.sourceEnvironmentId),
});
