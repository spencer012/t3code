import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseChannelOf,
  cliReleaseLatestCustomUrl,
  customReleaseTargetViolation,
  isCustomCliVersion,
  newestCliReleaseVersion,
  parseChecksums,
  parseLatestCustomVersion,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("derives the release channel from the version alone", () => {
    expect(cliReleaseChannelOf("1.2.3")).toBe("stable");
    expect(cliReleaseChannelOf("1.2.3-nightly.20260911.4")).toBe("nightly");
    expect(cliReleaseChannelOf("1.2.3-preview.20260911.4")).toBe("preview");
    expect(cliReleaseChannelOf("1.2.3-rc.1")).toBe("stable");
    expect(cliReleaseChannelOf("0.0.46-custom.1")).toBe("custom");
  });

  it("accepts only strict X.Y.Z-custom.N versions as custom", () => {
    expect(isCustomCliVersion("0.0.46-custom.12")).toBe(true);
    for (const version of [
      "0.0.46",
      "0.0.46-custom",
      "0.0.46-custom.1.2",
      "0.0.46-custom.1+build",
      "v0.0.46-custom.1",
      "0.0.46-custom.x",
      "../0.0.46-custom.1",
    ]) {
      expect(isCustomCliVersion(version)).toBe(false);
    }
  });

  it("reads latest-custom from the mirror root and rejects anything else", () => {
    expect(cliReleaseLatestCustomUrl("https://mirror:8443/t3/")).toBe(
      "https://mirror:8443/t3/latest-custom",
    );
    expect(parseLatestCustomVersion("0.0.46-custom.2\n")).toBe("0.0.46-custom.2");
    expect(parseLatestCustomVersion("0.0.47\n")).toBeUndefined();
    expect(parseLatestCustomVersion("<html>")).toBeUndefined();
  });

  it("keeps a custom build on custom releases from the mirror", () => {
    const mirror = "https://mirror:8443/t3";
    const custom = { runningVersion: "0.0.46-custom.1", releaseBaseUrl: mirror };
    expect(customReleaseTargetViolation({ ...custom, targetVersion: "0.0.46-custom.2" })).toBe(
      undefined,
    );
    expect(customReleaseTargetViolation({ ...custom, targetVersion: "0.0.47" })).toContain(
      "only installs",
    );
    expect(
      customReleaseTargetViolation({ ...custom, targetVersion: "0.0.47-nightly.20261001.1" }),
    ).toContain("only installs");
    for (const releaseBaseUrl of [undefined, "", "  "]) {
      expect(
        customReleaseTargetViolation({
          ...custom,
          releaseBaseUrl,
          targetVersion: "0.0.46-custom.2",
        }),
      ).toContain("T3CODE_RELEASE_BASE_URL");
    }
    // Upstream builds may switch to a custom build, mirror or not.
    expect(
      customReleaseTargetViolation({
        runningVersion: "0.0.46",
        targetVersion: "0.0.47",
        releaseBaseUrl: undefined,
      }),
    ).toBeUndefined();
  });
  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
