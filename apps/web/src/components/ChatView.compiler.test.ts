// @effect-diagnostics nodeBuiltinImport:off - compiles the real chat view source on disk.
import * as NodeFS from "node:fs";
import { transformSync } from "oxc-transform-react";
import { describe, expect, it } from "vite-plus/test";

describe("ChatView production compilation", () => {
  it("keeps React memoization enabled so render-time state guards converge", () => {
    const filename = new URL("./ChatView.tsx", import.meta.url);
    const compiled = transformSync(filename.pathname, NodeFS.readFileSync(filename, "utf8"), {
      reactCompiler: { reportDiagnostics: true },
    });

    expect(compiled.fatal).toBe(false);
    expect(compiled.errors).toEqual([]);
    expect(compiled.code).toMatch(
      /export default function ChatView\(props\) \{\s*const \$ = _c\(\d+\);/,
    );
  }, 30_000);
});
