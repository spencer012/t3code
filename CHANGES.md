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

## Continuous usage-limit recovery

Requested on 2026-10-08.

The user wants a button on a usage-limit stop that keeps continuation enabled
despite anything else happening in the thread, particularly background agent
messages and interrupted or replacement runs. It may automatically turn itself
off only after a successful foreground response with no unfinished agents,
running console commands, queued messages, or background results awaiting delivery.

- Keep the existing one-shot **Resume at reset** and snooze choices.
- Add **Continue until finished** on web, desktop, and mobile. The enabled state
  and **Stop continuing** remain visible after the usage-limit error disappears.
- Store the intent on the thread, independently of the failed run's identity.
  Background wakes, normal steering, provider changes, repeated failures,
  reconnects, and server restarts preserve it.
- Respect reported usage-reset deadlines. Missing or expired deadlines use
  bounded backoff. Keep retrying without requiring another click.
- Required approvals or user input pause execution while leaving the intent enabled.
- Count provider-reported background agents and commands, app-owned delegated
  tasks, pending completion delivery, and terminal subprocess activity. An idle
  shell is not running work. A dev server or active monitor keeps this mode armed.
- A successful response waiting on background agents, monitors, or consoles keeps
  the mode armed quietly. Use real completion notifications and queued results to
  wake the parent; do not periodically ask it for unchanged status.
- A native task ending after the parent response is unobserved work until a later
  response handles it. Do not disarm in the gap before its completion wake arrives.
- A completed background wake cannot erase an earlier root usage-limit deadline.
  Keep the mode armed and recover when the current provider quota resets, including
  a newer reset reported by a later failure. Finish only after a successful response
  after that reset with no work or results remaining.
- Automatic continuation messages contain only **Continue**. Checkpoint completion
  must finish before deciding the thread is done.
- Drain held queued messages after a successful recovery. Do not declare the
  thread finished with saved input or background results still waiting.
- Each attempt checks current state under the thread lock. An old check may
  neither duplicate a turn nor restart a cancelled mode.
- **Stop continuing** cancels future automatic attempts without interrupting
  current work. Explicit Stop, archive, and settle also cancel the mode.
  Automatic settlement must not end it.
- Use the same server command path from clients and the existing
  `t3_thread_update` MCP tool with `action="continuous_recovery"` and
  `enabled=true/false`.

When resolving conflicts, retain the distinction between successful foreground
completion and completion of the whole thread. The normal completion-notification
policy deliberately ignores long-running commands and cannot serve as this mode's
stopping rule. Keep one-shot recovery scoped to its original run.

Keep the indexed lookup for enabled threads, or an upstream equivalent. If migration
IDs collide, preserve both database changes and account for IDs already applied
to local databases. Do not reuse an applied ID for different SQL.

The core regression is: a usage-limit stop is armed, a background message replaces
the current run, and continuation still happens. Also preserve coverage for retry
deadlines, duplicate checks, busy consoles, pending agents/results, cancellation,
queue delivery, and persistence.

## Git workflow for this checkout

The upstream project currently uses the `origin` remote. Local customizations live
on `local/continuous-usage-recovery`, separate from upstream `main`. This branch
started from the fetched `origin/main` tip. No upstream history was rewritten.

Repository-local settings use fast-forward-only pulls, prune obsolete remote
tracking branches on fetch, and remember conflict resolutions with `rerere`.
Review reused resolutions before accepting them.

Keep changes in small commits. Fetch whenever useful, then integrate at deliberate
checkpoints with a clean working tree. For this private branch:

```sh
git fetch origin
git branch backup/before-update
git rebase origin/main
```

Use a new backup name each time. Resolve conflicts according to this file, stage
the resolved files, and run `git rebase --continue`. Use `git rebase --abort` to
return to the state before that rebase. Run the focused checks for the affected
changes after integrating.

A branch shared with other people should merge `origin/main` instead of rewriting
their published history. If a personal fork is added later, give the official
project an `upstream` remote and use `upstream/main` as the integration base.
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

## Continuation recovery corrections

Corrected on 2026-10-09.

Keep the thread-title and sidebar menus able to start or stop continuous recovery
when the usage-limit banner is absent. This also lets the user re-enable a flag
cleared by an older buggy build. Apply the same operate permission and existing-turn
guards across web, desktop, and mobile. Preserve explicit Stop/archive/settle
cancellation and queue delivery. Do not re-enable previously cleared flags without
a user action.

## Command to toggle automatic continuation

Requested on 2026-10-09.

Keep `/auto-continue` available in an existing thread without requiring a
usage-limit prompt. A bare command toggles the mode; `on` and `off` set it
explicitly, and `status` reports it. Web, desktop, and mobile handle the
standalone command directly through thread metadata, without prompting,
queuing a turn, steering the agent, or spending model usage. Keep the matching
command-palette actions reachable with the existing palette shortcut.

Preserve retry deadlines when the requested mode is already set. Invalid
arguments must show usage guidance instead of reaching a provider. Failed
updates retain the draft and never claim success. Keep operate permissions,
existing-turn validation, and old-server compatibility checks. Disabling the
mode leaves current agents and consoles running. This remains a mode for the
current task, with the existing completion and explicit cancellation rules.

## Release version and OpenCode 2 update

Requested on 2026-10-10.

The custom branch is rebased onto upstream main at `a8bdfdb541`, including its
OpenCode 2 fixes. Release package versions are `0.0.46` so the custom server
and clients report the expected release for compatibility. Keep server, web,
desktop, and contracts versions aligned through the release version script.
Adopt newer upstream release versions during future updates instead of keeping
this version pinned. Preserve the custom identity and continuation behavior.

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

Keep all local customizations on `local/continuous-usage-recovery`, rebased onto
upstream main at `ab6be13d43`. This branch includes the private release channel,
saved-connection request cards with JSON results and optional waiting, provider
quota reads, continuous recovery, custom branding, and the SFW build wrappers.
Use this branch for future custom releases instead of developing each feature on
separate long-lived branches. The release version is `0.1.0-custom.2`.

The old custom migration `61_ContinuousRecoveryIndex` now occupies ID 65.
Upgrading that exact legacy ledger atomically preserves its timestamp at 65 and
applies upstream migrations 61 through 64. Fresh and upstream databases use the
normal manifest. Preserve this upgrade path and its rollback tests when future
upstream migration IDs change.

The web/desktop chat view must remain eligible for React compiler memoization.
Keep continuation command try/catch/finally handling outside the component:
an unsupported callback made the compiler silently skip the whole view, and its
render-time timeline/setup state guards then looped on fresh object references
before startup could display a draft. The compiler regression test checks the
actual ChatView module for diagnostics and generated memoization.

## Personal details stay out of the fork

Requested on 2026-10-19.

`AGENTS.md` forbids committing personal or deployment details, so this branch
can be published. Keep that rule when merging upstream changes to `AGENTS.md`.
This branch's history was rewritten on 2026-10-19 to remove such details. Local
branches created before then, including `backup/*`, still contain them and must
not be pushed.
