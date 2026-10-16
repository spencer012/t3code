const CLI_RELEASE_REPOSITORY = "pingdotgg/t3code";
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
export const CLI_RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";

/**
 * Kept in step with the build_linux_cli matrix, build_windows_arm64_cli, and
 * the `cli_archive` rows in .github/workflows/release.yml: a key here without a
 * build there produces download URLs that 404, and a build there without a key
 * here is unreachable from every installer.
 */
// No darwin-x64: Node single-executables are unsupported on x64 macOS (the
// SEA docs list macOS as arm64 only) and the binary segfaults on start.
const CLI_ARCHIVE_PLATFORM_KEYS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/**
 * Windows ships bsdtar in System32, which reads both formats; a Git-for-Windows
 * GNU tar earlier on PATH cannot open the zip, so the system copy is named by
 * absolute path.
 */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `t3-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;

export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return `${(baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v${version}`;
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "stable" | "nightly" | "preview" | "custom";
export const CLI_RELEASE_CHANNELS: ReadonlyArray<CliReleaseChannel> = [
  "stable",
  "nightly",
  "preview",
  "custom",
];

// Fork builds are `X.Y.Z-custom.N` and are only ever served from a private
// mirror. Kept strict so a custom build can never be matched by a looser tag.
const CUSTOM_CLI_VERSION = /^\d+\.\d+\.\d+-custom\.\d+$/;

/** Whether a version is a fork build that only installs from the custom mirror. */
export function isCustomCliVersion(version: string): boolean {
  return CUSTOM_CLI_VERSION.test(version);
}

/** The release train a version was published on, derived from its prerelease tag. */

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  if (isCustomCliVersion(version)) return "custom";
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

/** File at the mirror root naming the newest published custom version. */
export const CLI_RELEASE_LATEST_CUSTOM_FILE = "latest-custom";

export function cliReleaseLatestCustomUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/${CLI_RELEASE_LATEST_CUSTOM_FILE}`;
}

/** The version named by a `latest-custom` file, or undefined if it is not a custom version. */
export function parseLatestCustomVersion(text: string): string | undefined {
  const version = text.trim();
  return isCustomCliVersion(version) ? version : undefined;
}

/**
 * Why a running build may not move to `targetVersion`, or undefined when it
 * may. A custom build installs only custom versions, and only from the
 * mirror: without one the download would fall back to upstream GitHub.
 * Upstream builds are unrestricted, so they can switch to a custom build.
 */
export function customReleaseTargetViolation(input: {
  readonly runningVersion: string;
  readonly targetVersion: string;
  readonly releaseBaseUrl: string | undefined;
}): string | undefined {
  if (!isCustomCliVersion(input.runningVersion)) return undefined;
  if (!isCustomCliVersion(input.targetVersion)) {
    return `t3@${input.runningVersion} is a custom build and only installs X.Y.Z-custom.N releases; refusing t3@${input.targetVersion}.`;
  }
  if (!input.releaseBaseUrl?.trim()) {
    return `t3@${input.runningVersion} is a custom build; set ${CLI_RELEASE_BASE_URL_ENV} to the custom release mirror before updating.`;
  }
  return undefined;
}

/**
 * Callers walk pages until a channel match turns up; a busy nightly train can push the newest
 * preview or stable release past any single page.
 */
export function cliReleaseIndexPageUrl(page: number): string {
  return `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;
}

/**
 * Drafts are skipped because their assets are not downloadable.
 */
export function newestCliReleaseVersion(
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft?: boolean | undefined;
  }>,
  channel: CliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
    if (version === undefined) continue;
    if (cliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}
