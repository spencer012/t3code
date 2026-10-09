import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";

export function UsageLimitRecoveryCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resetAt = thread.runtime?.usageLimitResetAt ?? null;
  const nextAttemptAt = thread.continuousRecovery?.nextAttemptAt ?? null;
  useEffect(() => {
    const now = Math.max(nowMs, Date.now());
    const deadlines = [Date.parse(resetAt ?? ""), Date.parse(nextAttemptAt ?? "")].filter(
      (deadline) => Number.isFinite(deadline) && deadline > now,
    );
    if (deadlines.length === 0) return;
    const timer = setTimeout(
      () => setNowMs(Date.now()),
      Math.min(Math.min(...deadlines) - now + 1, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [resetAt, nextAttemptAt, nowMs]);
  const canSchedule =
    resetAt !== null &&
    Date.parse(resetAt) > Date.parse(thread.latestRun?.completedAt ?? thread.updatedAt);
  // Whether the reset already passed is state a timer flips at resetAt: the
  // compiler caches render output on its inputs, so reading the clock during
  // render would leave the snooze button enabled after the reset.
  const resetAtMs = resetAt === null ? null : Date.parse(resetAt);
  const [resetPassedFor, setResetPassedFor] = useState<number | null>(null);
  const resetPassed = resetAtMs !== null && resetPassedFor === resetAtMs;
  useEffect(() => {
    if (resetAtMs === null || Number.isNaN(resetAtMs)) return;
    const flip = () => setResetPassedFor(resetAtMs);
    const delay = resetAtMs - Date.now();
    if (delay <= 0) {
      flip();
      return;
    }
    // Beyond setTimeout's 32-bit range the card re-renders long before then.
    if (delay > 2_147_483_647) return;
    const timer = setTimeout(flip, delay);
    return () => clearTimeout(timer);
  }, [resetAtMs]);
  const runId = thread.latestRun?.runId;
  const recovery = thread.limitRecovery;
  const scheduled =
    recovery?.runId === runId && recovery?.resetAt === resetAt && recovery?.autoResume;
  const continuous = thread.continuousRecovery != null;
  const limited =
    thread.runtime?.status === "failed" && thread.runtime.lastErrorClass === "usage_limit";
  const awaitingRetry =
    thread.continuousRecovery != null &&
    ["failed", "interrupted", "cancelled"].includes(thread.runtime?.status ?? "") &&
    Date.parse(thread.continuousRecovery.nextAttemptAt) > nowMs;
  if (!limited && !continuous) return null;
  const snoozed =
    recovery?.snooze === true &&
    recovery.runId === runId &&
    recovery.resetAt === resetAt &&
    resetAt !== null &&
    thread.snoozedUntil !== null &&
    Date.parse(thread.snoozedUntil) === Date.parse(resetAt);
  async function toggle(action: "resume" | "snooze" | "continuous") {
    if (!canOperate) return;
    if (action !== "continuous" && (!resetAt || !runId || !canSchedule)) return;
    if (action === "snooze" && !snoozed && Date.parse(resetAt!) <= Date.now()) {
      setError("The reset time has passed. Retry the thread manually.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await updateMetadata({
      environmentId,
      input: {
        threadId: thread.id,
        ...(action === "continuous"
          ? { continuousRecovery: !continuous }
          : {
              limitRecovery: {
                runId: runId!,
                resetAt: resetAt!,
                ...(action === "resume" ? { autoResume: !scheduled } : { snooze: !snoozed }),
              },
            }),
      },
    });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not change limit recovery.");
    }
  }
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text className="text-sm text-warning-foreground">
        {continuous
          ? thread.hasPendingApprovals || thread.hasPendingUserInput
            ? "Waiting for your response. Automatic continuation remains enabled."
            : awaitingRetry
              ? "Next continuation after " +
                new Date(thread.continuousRecovery!.nextAttemptAt).toLocaleString() +
                "."
              : "Continuing until the response, agents, and console commands finish."
          : resetAt
            ? `Usage limit resets ${DateTime.toDateUtc(DateTime.makeUnsafe(resetAt)).toLocaleString()}.`
            : "Reset time unavailable; continuous recovery will retry with backoff."}
      </Text>
      {limited && canSchedule ? (
        <View className="flex-row flex-wrap gap-2">
          <Pressable
            accessibilityRole="button"
            disabled={!canOperate || pending || continuous}
            onPress={() => void toggle("resume")}
            className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
          >
            <Text className="text-sm text-foreground">
              {scheduled ? "Cancel auto-resume" : "Resume at reset"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!canOperate || pending || (!snoozed && resetPassed)}

            onPress={() => void toggle("snooze")}
            className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
          >
            <Text className="text-sm text-foreground">
              {snoozed ? "Wake now" : "Snooze until reset"}
            </Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={!canOperate || pending}
        onPress={() => void toggle("continuous")}
        className="self-start rounded-lg bg-subtle px-3 py-2 active:opacity-70"
      >
        <Text className="text-sm text-foreground">
          {pending ? "Saving..." : continuous ? "Stop continuing" : "Continue until finished"}
        </Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
