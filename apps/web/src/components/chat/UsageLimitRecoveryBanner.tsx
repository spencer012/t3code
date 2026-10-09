import {
  type OrchestrationV2ContinuousRecovery,
  type OrchestrationV2LimitRecovery,
  type OrchestrationV2LimitRecoveryUpdate,
  type RunId,
} from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type RecoveryProps = {
  runId: RunId;
  resetAt: string | null;
  stoppedAt: string;
  snoozedUntil: string | null;
  recovery: OrchestrationV2LimitRecovery | null;
  continuousRecovery: OrchestrationV2ContinuousRecovery | null;
  disabled: boolean;
  onChange: (recovery: OrchestrationV2LimitRecoveryUpdate) => Promise<void>;
  onContinuousChange: (enabled: boolean) => Promise<void>;
};

export function usageLimitRecoveryBannerItem(props: RecoveryProps): ComposerBannerStackItem {
  const { runId, resetAt } = props;
  return {
    id: "usage-limit-recovery:" + runId,
    variant: "warning",
    priority: "urgent",
    icon: <GaugeIcon />,
    title: "Usage limit reached",
    description: resetAt
      ? "Resets " + new Date(resetAt).toLocaleString()
      : "Reset time unavailable; continuous recovery will retry with backoff",
    actions: <RecoveryActions key={runId + ":" + resetAt} {...props} />,
  };
}

export function continuousRecoveryBannerItem(props: {
  recovery: OrchestrationV2ContinuousRecovery;
  disabled: boolean;
  waitingForInput: boolean;
  stopped: boolean;
  onStop: () => Promise<void>;
}): ComposerBannerStackItem {
  return {
    id: "continuous-recovery",
    variant: "info",
    icon: <GaugeIcon />,
    title: "Continuing until finished",
    description: props.waitingForInput
      ? "Waiting for your response. Automatic continuation remains enabled."
      : props.stopped
        ? "Next continuation after " + new Date(props.recovery.nextAttemptAt).toLocaleString() + "."
        : "Continues after interruptions until the response, agents, and console commands finish.",
    actions: <StopContinuousRecovery disabled={props.disabled} onStop={props.onStop} />,
  };
}

function StopContinuousRecovery({
  disabled,
  onStop,
}: {
  disabled: boolean;
  onStop: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function stop() {
    setPending(true);
    setError(null);
    try {
      await onStop();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop continuous recovery.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="xs" variant="ghost" disabled={disabled || pending} onClick={() => void stop()}>
        {pending ? "Saving..." : "Stop continuing"}
      </Button>
      {error ? (
        <p role="alert" className="basis-full text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function RecoveryActions({
  runId,
  resetAt,
  stoppedAt,
  recovery,
  continuousRecovery,
  snoozedUntil,
  disabled,
  onChange,
  onContinuousChange,
}: RecoveryProps) {
  const [pending, setPending] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const canSchedule = resetAt !== null && Date.parse(resetAt) > Date.parse(stoppedAt);
  useEffect(() => {
    const delay = Date.parse(resetAt ?? "") - Math.max(nowMs, Date.now());
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setNowMs(Date.now()), Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [resetAt, nowMs]);

  const scheduled =
    recovery?.runId === runId && recovery.resetAt === resetAt && recovery.autoResume;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    snoozedUntil !== null &&
    Date.parse(snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze" | "continuous") {
    if (action !== "continuous" && resetAt === null) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt!) <= Date.now()) {
      toastManager.add({
        type: "error",
        title: "Could not snooze thread",
        description: "The reset time has passed. Retry the thread manually.",
      });

      setNowMs(Date.now());
      return;
    }
    setPending(true);
    try {
      if (action === "continuous") {
        await onContinuousChange(true);
      } else {
        await onChange({
          runId,
          resetAt: resetAt!,
          ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
        });
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "resume" ? "Could not change auto-resume" : "Could not snooze thread",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    } finally {
      setPending(false);

    }
  }
  // Failures go to a toast: the actions column is auto-sized, so inline error
  // text would widen it and crush the title.
  return (
    <>
      {canSchedule ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || pending || continuousRecovery !== null}
            onClick={() => void toggle("resume")}
          >
            {pending ? "Saving..." : scheduled ? "Cancel auto-resume" : "Resume at reset"}
          </Button>
          {!snoozed ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled || pending || Date.parse(resetAt!) <= nowMs}
              onClick={() => void toggle("snooze")}
            >
              {pending ? "Saving..." : "Snooze until reset"}
            </Button>
          ) : null}
        </>
      ) : null}
      {continuousRecovery === null ? (

        <Button
          size="xs"
          variant="ghost"
          disabled={disabled || pending}
          onClick={() => void toggle("continuous")}
        >
          {pending ? "Saving..." : "Continue until finished"}
        </Button>
      ) : null}
    </>
  );
}
