# Local changes

`AGENTS.md` directs future agents to maintain this record for each local customization.

This file records the requested changes to this checkout. Update it whenever
a new local customization is added or its behavior changes. During a rebase or
merge, preserve the intent below while adopting upstream implementations where
they provide the same behavior. Do not preserve obsolete code just to avoid a
rewrite.

## Agent requests for saved connections

Requested on 2026-10-16.

Agents in live full-access/default threads can call `t3_saved_connection_add`
with a single-use pairing URL, or `t3_saved_connection_remove` with an environment
id, exact label, or host. Each call returns immediately and records a card in
that thread. Add/Remove and Decline require one click in the desktop or web app.
The app that answers changes its own saved connections through the same onboarding
and removal services as Settings. Removing forgets its saved credential and cached
threads; it makes no change to the remote machine. Mobile shows a prompt to use
the desktop or web app.

- Preserve immediate pending results and idempotent `clientRequestId` retries.
  Outcomes notify the asking agent through the normal queued message path, even
  after its original turn ends. Claude threads only receive that notification
  once the turn is over, so an optional `waitMs` (max 120 s, no lock held) lets
  the call return the answer itself. A waiting call replaces the notification;
  if it ends without returning the outcome (interrupt, failure), it sends the
  notification it suppressed. Never wait by default.
- Keep pairing URLs in server memory only. Cards, events, notifications, provider
  logs, and normalized tool-call inputs must contain no pairing token. Decline,
  completion, expiry, Stop, and archive discard it. A restarted server cannot
  resume redemption; clicking its old card reports a failure and asks for a new link.
- One client may claim each card. Lost clients expire after two minutes; unanswered
  cards expire after fifteen minutes. Expired pairing credentials ask the agent to
  mint a new link. Ambiguous removal targets require a more specific request.
- Never remove primary/platform connections. A request cannot remove the connection
  hosting its own thread, because that would disconnect the outcome channel; ask
  from another environment. Saved SSH removal uses the existing local tunnel cleanup.
- Outside OAuth MCP clients cannot request these cards. A card is consent to change
  the answering client, not a server-to-server link or permission on a remote machine.
- Omit absent fields from tool results instead of setting them to `undefined`.
  MCP `structuredContent` must be JSON; in 0.0.46-custom.3 the card was recorded
  but the tool call itself returned an internal server error.

When merging upstream work, prefer its card/action/notification infrastructure if
it preserves these client-local semantics. Do not import the linked-environments
stack merely to keep this feature. Both the app and the server hosting the asking
thread need this customization; a target box only needs ordinary pairing support.

## Git workflow for this checkout

`upstream` is the official project and `origin` is the public fork. Local
customizations live on `custom`, published as `origin/custom`. `main` mirrors
`upstream/main` with no local changes, so the fork's **Sync fork** button keeps
working and branches for upstream pull requests can start from it.

Repository-local settings use fast-forward-only pulls, prune obsolete remote
tracking branches on fetch, and remember conflict resolutions with `rerere`.
Review reused resolutions before accepting them.

Keep changes in small commits. Fetch whenever useful, then integrate at deliberate
checkpoints with a clean working tree:

```sh
git fetch upstream
git branch backup/before-update
git rebase upstream/main
git push --force-with-lease origin custom
```

Use a new backup name each time, and keep backups local. Resolve conflicts according to this file, stage
the resolved files, and run `git rebase --continue`. Use `git rebase --abort` to
return to the state before that rebase. Run the focused checks for the affected
changes after integrating.

Only this checkout pushes `custom`, so rebasing its published history is fine;
`--force-with-lease` refuses to overwrite commits pushed from elsewhere. If other
people start building on `custom`, merge `upstream/main` instead of rebasing.
When the developer requests a new feature, rebase onto the latest `upstream/main`
before starting it unless they explicitly say not to (requested 2026-10-22).
Do not automatically rebase a dirty checkout or chase every upstream commit while
a feature is being implemented. Do not resolve conflicts by blindly selecting
all local or all upstream versions.

## Custom server upgrades

Requested on 2026-10-08.

The custom Linux CLI archive can replace a deployed server's runtime without
inspecting its active work. It keeps the existing T3 home and connection
configuration. Keep the previous runtime available for rollback.

Upgrade checks may inspect server code, service metadata, and the read-only
database migration ledger. Do not inspect working files, conversations, or server
logs to perform an upgrade. Check migration IDs before switching builds and test
the replacement with an isolated data home. Install locations, startup overrides,
and deployment history for specific machines are kept outside this repository.

## Custom client identity and installer launcher

Requested on 2026-10-08.

Clients built from this fork must visibly identify themselves as
**T3 Code (Custom)**. Keep that label in the sidebar and window/tab title, the
native About panel, mobile branding, and desktop package names. A remote
environment's release channel must not hide the custom client identity.
Preserve the existing application ID, profile directories, and saved connections.

Use distinct **T3-Code-Custom** desktop artifact names so an older upstream
installer cannot be mistaken for the local build.

**Install-T3-Code.cmd** must build the current checkout before offering to install
the newly produced Windows package. Preserve local changes; upstream integration
remains the deliberate Git workflow above. Do not install an older artifact after
a failed build. Include a Linux WSL runtime built from the same source, and keep
package-validation temporary directories outside ancestors with node_modules.
The launcher requires Docker Desktop with Linux containers for that runtime.

The user must explicitly quit the running desktop client before the launcher
starts installation. Changing the remote server alone does not update the
desktop client's bundled UI. Do not close the live client from an agent session.

## Windows taskbar icon refresh

Requested on 2026-10-08.

The Custom rename can leave Windows displaying a cached blank taskbar icon even
when the executable and shortcuts contain the correct T3 icon. After installation,
refresh only the Custom executable and its Start Menu/Desktop shortcut references
through Shell change notifications. Preserve this step when changing the installer
workflow or display name. Keep the app, Explorer, pinned positions, unrelated icon
caches, and user data intact. A scoped refresh restored the icon on this machine.

## Release version and OpenCode 2 update

Requested on 2026-10-10.

The custom branch is rebased onto upstream main at `a8bdfdb541`, including its
OpenCode 2 fixes. Release package versions are `0.0.46` so the custom server
and clients report the expected release for compatibility. Keep server, web,
desktop, and contracts versions aligned through the release version script.
Adopt newer upstream release versions during future updates instead of keeping
this version pinned. Preserve the custom identity.

## Provider quota for manager agents

Requested on 2026-10-10.

Agents can call `t3_provider_usage_limits` to read session, weekly, and monthly
quota for every provider instance and usage-limit hub account, so a manager
agent can scale its subagents to the quota left. This adopts upstream PR #17219,
which was still awaiting maintainer approval. If upstream merges it or a
replacement, take upstream's version and re-apply only the behavior below.

The local addition is the optional `maxAgeSeconds` input (minimum 60). Quota
older than that is re-checked before the read, because background refreshes
only run while a client is in the foreground and OpenCode never refreshes its Go
quota on an interval. Only enabled instances that report quota are re-checked;
unsupported and disabled instances are not. Without the input, the read stays
cache-only. Keep OpenCode Go accounts covered: each OpenCode instance reads its
own credentials and reports its own Go windows.

## Custom release channel

Requested on 2026-10-15.

Custom builds are versioned `X.Y.Z-custom.N` and are published only to a private
mirror named by `T3CODE_RELEASE_BASE_URL`, whose `latest-custom` file names the
newest one. Bump all release packages together with
`scripts/update-release-package-versions.ts`. The mirror's address, certificate,
and publishing script are deployment details kept outside this repository.

- A custom build installs only other custom builds, and only from the mirror.
  It never asks GitHub. Without the mirror variable, `t3 update`, remote server
  updates and runtime downloads fail instead of falling back to upstream.
- The guard runs wherever a target is accepted: `t3 update` (bare, `--channel`,
  explicit versions, `--allow-downgrade`), the server self-update RPC, the
  pinned-runtime installer (including cached runtimes), and the service
  launcher's update hand-off. Keep it in every one of those paths.
- Upstream builds are unrestricted, so an upstream server can move to a custom
  build with `t3 update X.Y.Z-custom.N --allow-downgrade`; SemVer orders
  `0.0.46-custom.1` below `0.0.46`.
- `t3 service install` writes `T3CODE_RELEASE_BASE_URL` and
  `NODE_EXTRA_CA_CERTS` from the installing shell into the unit (or plist).
- Two custom versions compare in full in the client version-skew check, so
  `custom.1` against `custom.2` offers **Update server**.
- Mobile does not check for updates on custom servers; the phone cannot reach
  the mirror. Update those from the desktop app or with `t3 update`.
- `scripts/install.sh` defaults to the custom channel when the mirror variable
  is set, reads `latest-custom`, and validates `T3CODE_VERSION` before its
  download cache shortcut.
- The custom Linux build (`scripts/build-custom-linux.sh` in the
  `linux-custom-builder` image) routes package downloads through Socket
  Firewall: the image installs a pinned, checksummed `sfw`, and the build runs
  `sfw pnpm install`, `sfw cargo build`, and the archive step (whose own
  `vp install --prod` inherits sfw's proxy) under it.
- `scripts/build-install-custom.ps1` does the same on Windows: `sfw pnpm
  install` and `sfw vp run dist:desktop:artifact`. `-LinuxRuntime <archive>`
  reuses a Linux runtime already built from the same commit instead of
  running the Docker build.

When adopting upstream changes to release discovery or runtime installation,
keep these refusals ahead of any download or cache reuse.

## Consolidated custom release

Requested on 2026-10-18.

Keep all local customizations on `custom`, rebased onto
upstream main at `15fe283272`. This branch includes the private release channel,
saved-connection request cards with JSON results and optional waiting, provider
quota reads, custom branding, and the SFW build wrappers.
Use this branch for future custom releases instead of developing each feature on
separate long-lived branches. The release version is `0.1.6-custom.1`.

## Continuous usage-limit recovery removed

Removed on 2026-11-03 at the developer's request; it is no longer needed.
Do not restore **Continue until finished**, `/auto-continue`, or the
`continuous_recovery` thread-update action when merging.

Custom releases recorded its `ContinuousRecoveryIndex` migration at 61, 65, 68,
73, or 77, all IDs upstream has since assigned. On startup, an exact legacy ledger
(nothing recorded after that row) drops the index and forgets the row, so the
normal migrator applies upstream's migrations from that ID. Keep this shim, with
its test, while databases written by those releases may still upgrade. Leftover
`continuousRecovery` keys in stored thread payloads are ignored when decoded.

## Personal details stay out of the fork

Requested on 2026-10-19.

`AGENTS.md` forbids committing personal or deployment details, so this branch
can be published. Keep that rule when merging upstream changes to `AGENTS.md`.
This branch's history was rewritten on 2026-10-19 to remove such details. Local
branches created before then, including `backup/*`, still contain them and must
not be pushed.
