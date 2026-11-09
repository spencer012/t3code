import { assert, it } from "@effect/vitest";
import { redactPairingData } from "./pairingPrivacy.ts";
import {
  boundProviderEventForLogging,
  shouldPersistProviderEvent,
} from "../provider/EventNdjsonLogger.ts";

it("redacts saved-connection pairing URLs but leaves them in ordinary text", () => {
  const token = "one-use-SECRET";
  const url = `https://foo.test/pair#token=${token}`;
  for (const event of [
    {
      toolName: "mcp__t3_code__t3_saved_connection_add",
      input: { pairingUrl: url, clientRequestId: "x" },
    },
    {
      type: "mcpToolCall",
      tool: "t3_saved_connection_add",
      arguments: JSON.stringify({ pairingUrl: url }),
    },
    { type: "tool_use", name: "mcp__t3-code__t3_saved_connection_add", input: { pairingUrl: url } },
  ]) {
    assert.notInclude(JSON.stringify(redactPairingData(event)), token);
    assert.notInclude(JSON.stringify(boundProviderEventForLogging(event)), token);
  }
  const message = { type: "assistant", text: `Use ${url}.` };
  assert.deepEqual(redactPairingData(message), message);
  // Native input fragments do not contain the tool name or a complete URL.
  assert.isFalse(
    shouldPersistProviderEvent("native", {
      event: {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: token },
        },
      },
    }),
  );
});
