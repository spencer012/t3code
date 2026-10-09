import { describe, expect, it } from "vite-plus/test";
import { parseAutoContinueCommand, runAutoContinueCommand } from "./continuousRecoveryCommand.ts";

describe("automatic continuation composer command", () => {
  it.each([
    ["/auto-continue", "toggle"],
    ["  /AUTO-CONTINUE  ", "toggle"],
    ["/auto-continue on", "on"],
    ["/auto-continue OFF", "off"],
    ["/auto-continue status", "status"],
    ["/auto-continue toggle", "invalid"],
    ["/auto-continue on please", "invalid"],
    ["/auto-continue\non\noff", "invalid"],
    ["/auto-continue-now", null],
    ["Explain /auto-continue", null],
    ["/continue", null],
  ])("recognizes %j as %j", (text, expected) => {
    expect(parseAutoContinueCommand(text)).toBe(expected);
  });

  it("arms before a usage limit and toggles the mode off again", async () => {
    let recovery = false;
    const update = async (enabled: boolean) => {
      recovery = enabled;
    };
    expect(await runAutoContinueCommand("toggle", recovery, update)).toBe(
      "Automatic continuation is on",
    );
    expect(recovery).toBe(true);
    expect(await runAutoContinueCommand("toggle", recovery, update)).toBe(
      "Automatic continuation is off",
    );
    expect(recovery).toBe(false);
  });

  it.each([
    ["on", true],
    ["off", false],
    ["status", true],
    ["status", false],
  ] as const)("%s with mode=%s preserves the retry deadline", async (action, enabled) => {
    const deadline = "2026-10-09T12:00:00Z";
    let storedDeadline = deadline;
    const feedback = await runAutoContinueCommand(action, enabled, async () => {
      storedDeadline = "2026-10-09T10:00:00Z";
    });
    expect(storedDeadline).toBe(deadline);
    expect(feedback).toBe(
      enabled ? "Automatic continuation is on" : "Automatic continuation is off",
    );
  });

  it("reports invalid arguments without enabling recovery", async () => {
    let enabled = false;
    await expect(
      runAutoContinueCommand("invalid", enabled, async (value) => {
        enabled = value;
      }),
    ).rejects.toThrow("Use /auto-continue");
    expect(enabled).toBe(false);
  });

  it("reports a rejected server toggle instead of claiming success", async () => {
    await expect(
      runAutoContinueCommand("on", false, async () => {
        throw new Error("Permission denied");
      }),
    ).rejects.toThrow("Permission denied");
  });
});
