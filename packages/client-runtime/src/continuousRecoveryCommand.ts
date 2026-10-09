export const AUTO_CONTINUE_COMMAND = {
  name: "auto-continue",
  description: "Toggle automatic continuation; accepts on, off, or status",
} as const;

export type AutoContinueAction = "toggle" | "on" | "off" | "status" | "invalid";

/** Only a standalone app command is intercepted. Invalid arguments stay out of the provider. */
export function parseAutoContinueCommand(text: string): AutoContinueAction | null {
  const match = /^\/auto-continue(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const argument = match[1]?.trim().toLowerCase() ?? "";
  if (argument === "") return "toggle";
  if (argument === "on" || argument === "off" || argument === "status") return argument;
  return "invalid";
}

/** Idempotent on/off preserve the recovery deadline; status never mutates the thread. */
export async function runAutoContinueCommand(
  action: AutoContinueAction,
  enabled: boolean,
  update: (enabled: boolean) => Promise<void>,
): Promise<string> {
  if (action === "invalid") {
    throw new Error(
      "Use /auto-continue, /auto-continue on, /auto-continue off, or /auto-continue status.",
    );
  }
  const next = action === "status" ? enabled : action === "toggle" ? !enabled : action === "on";
  if (next !== enabled) await update(next);
  return next ? "Automatic continuation is on" : "Automatic continuation is off";
}
