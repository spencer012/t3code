import { useAtomValue } from "@effect/atom-react";
import { savedConnectionOutcomeText } from "@t3tools/client-runtime/saved-connection-request";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  SavedConnectionRespondInput,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { executeSavedConnection } from "../../connection/onboarding";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

type Card = Extract<OrchestrationV2TurnItem, { type: "saved_connection_request" }>;

export function SavedConnectionRequestCard(props: {
  environmentId: EnvironmentId;
  item: Card;
  visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item, environmentId } = props;
  const respond = useAtomCommand(serverEnvironment.respondSavedConnectionRequest, {
    reportFailure: false,
    reportDefect: false,
  });
  const execute = useAtomCommand(executeSavedConnection, {
    reportFailure: false,
    reportDefect: false,
  });
  const allowed = useAtomValue(
    serverEnvironment.respondSavedConnectionRequest.permissionAtom(environmentId),
  );
  const inFlight = useRef(false);
  const completion = useRef<SavedConnectionRespondInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReceipt, setNeedsReceipt] = useState(false);

  const send = async (action: "claim" | "decline" | "receipt") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action !== "receipt") {
        const claimId = randomUUID();
        const claimed = await respond({
          environmentId,
          input: {
            threadId: item.threadId,
            turnItemId: item.id,
            answer: action === "decline" ? { type: "decline" } : { type: "claim", claimId },
          },
        });
        if (claimed._tag === "Failure") {
          setError("Could not answer this card. Refresh the thread and try again.");
          return;
        }
        if (action === "decline" || claimed.value.request.connectionStatus !== "claimed") return;
        // The token goes straight from the ephemeral response to normal onboarding.
        // No React state, toast, log, or persisted completion holds it.
        const result = await execute({
          request: claimed.value.request,
          pairingUrl: claimed.value.pairingUrl,
          sourceEnvironmentId: environmentId,
        });
        completion.current = {
          threadId: item.threadId,
          turnItemId: item.id,
          answer: {
            type: "complete",
            claimId,
            outcome:
              result._tag === "Success"
                ? result.value
                : { type: "failed", reason: "client_failed" },
          },
        };
      }
      if (completion.current === null) return;
      const finished = await respond({ environmentId, input: completion.current });
      if (finished._tag === "Failure") {
        setNeedsReceipt(true);
        setError(
          "The app finished the action but could not notify the agent. Retry sending its result.",
        );
      } else {
        completion.current = null;
        setNeedsReceipt(false);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const actionable = props.visibility === "local" && item.connectionStatus === "pending";
  return (
    <div
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <p className="text-sm font-medium">
        {busy
          ? "Updating saved connections..."
          : savedConnectionOutcomeText({ ...item, turnItemId: item.id })}
      </p>
      {actionable ? (
        <>
          <p className="text-xs text-muted-foreground">
            {item.operation === "remove"
              ? "This forgets the connection, credentials, and cached threads on this device. The remote machine stays running."
              : "This app will redeem the pairing link and save the connection."}
          </p>
          <div className="flex items-center gap-2">
            <Button
              disabled={busy || !allowed}
              variant={item.operation === "remove" ? "destructive" : "default"}
              onClick={() => void send("claim")}
            >
              {item.operation === "add" ? "Add" : "Remove"}
            </Button>
            <Button
              disabled={busy || !allowed}
              variant="ghost-muted"
              onClick={() => void send("decline")}
            >
              Decline
            </Button>
          </div>
        </>
      ) : null}
      {props.visibility === "local" &&
      item.connectionStatus === "claimed" &&
      !busy &&
      !needsReceipt ? (
        <Button disabled={!allowed} variant="outline" onClick={() => void send("claim")}>
          Check request
        </Button>
      ) : null}
      {needsReceipt ? (
        <Button disabled={busy || !allowed} variant="outline" onClick={() => void send("receipt")}>
          Send result again
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
