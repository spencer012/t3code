import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  CLI_RELEASES_PAGE_URL,
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
} from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Schema from "effect/Schema";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

export function supportsEnvironmentUpdate(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
) {
  return (
    capabilities.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

export function canUpdateEnvironmentProvider(provider: ServerProvider) {
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  return (
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.versionAdvisory.latestVersion !== null &&
    compatibility !== "broken" &&
    compatibility !== "unsupported" &&
    provider.updateState?.status !== "running" &&
    provider.updateState?.status !== "queued"
  );
}

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optionalKey(Schema.Boolean),
});
const decodeRelease = Schema.decodeUnknownSync(Release);
const decodeReleases = Schema.decodeUnknownSync(Schema.Array(Release));

async function fetchReleases(url: string, accept: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, headers: { Accept: accept } });
  if (!response.ok) throw new Error(`Could not check releases (${response.status}). Try again.`);
  return response;
}

/**
 * Custom builds are published only to a private mirror the phone cannot
 * reach, so the phone never looks for their updates on GitHub.
 */
export function canCheckEnvironmentUpdate(currentVersion: string) {
  return cliReleaseChannelOf(currentVersion) !== "custom";
}

/** Preserve the host's release channel and never offer a downgrade. */

export async function findEnvironmentUpdate(currentVersion: string, signal: AbortSignal) {
  const channel = cliReleaseChannelOf(currentVersion);
  if (channel === "custom") {
    throw new Error("Update custom builds from the desktop app or with t3 update on the host.");
  }
  // Public release pages avoid the anonymous API quota shared by devices on the same network.
  const response = await fetchReleases(
    channel === "stable" ? `${CLI_RELEASES_PAGE_URL}/latest` : `${CLI_RELEASES_PAGE_URL}.atom`,
    channel === "stable" ? "application/json" : "application/atom+xml",
    signal,
  );
  const releases =
    channel === "stable"
      ? [decodeRelease(await response.json())]
      : Array.from(
          (await response.text()).matchAll(
            /<id>tag:github\.com,2008:Repository\/\d+\/([^<]+)<\/id>/g,
          ),
          ([, tag_name = ""]) => ({ tag_name }),
        );
  let version = newestCliReleaseVersion(releases, channel);

  // The feed only includes ten releases, so later nightlies can displace a published preview.
  for (let page = 1; version === undefined; page++) {
    const response = await fetchReleases(
      cliReleaseIndexPageUrl(page),
      "application/vnd.github+json",
      signal,
    );
    const releases = decodeReleases(await response.json());
    version = newestCliReleaseVersion(releases, channel);
    if (releases.length < 100) break;
  }

  if (version === undefined) throw new Error(`No ${channel} release was found.`);
  return compareSemverVersions(version, currentVersion) > 0 ? version : null;
}
