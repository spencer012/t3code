# Local changes

`AGENTS.md` directs future agents to maintain this record for each local customization.

This file records the requested changes to this checkout. Update it whenever
a new local customization is added or its behavior changes. During a rebase or
merge, preserve the intent below while adopting upstream implementations where
they provide the same behavior. Do not preserve obsolete code just to avoid a
rewrite.

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

## Container server installation

Requested on 2026-10-08.

Install the custom server in the server container without inspecting its active work.
The custom Linux CLI archive replaces the nightly server.
It uses the existing T3 home and connection configuration.

Build directories live under the container's runtime cache.
`local/current` selects the installed build, and `bin/t3` points to that selection. Keep the
previous npm runtime available for rollback. The original launcher metadata and
container startup script are backed up under `local/backups/before-74b88c249e`.

The container's startup script now honors `local/current/t3` before its
configured nightly updater. Preserve this override when rebuilding the container
image so restarts and the nightly updater keep the custom behavior.

Installation checks may inspect server code, service metadata, and the read-only
database migration ledger. Do not inspect working files, conversations, or server
logs to perform an upgrade. Check migration IDs before switching builds and test
the replacement with an isolated data home. The deployed build passed those
checks and responded on the existing port, `3773`.

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
cleared by an older buggy build. The corrected server build `f25cceab9f` is deployed
in the server container, with the prior runtime retained for rollback. Apply the same operate permission and existing-turn
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

The matching Windows and Linux packages were rebuilt from `f25cceab9f`, and
the container now serves that build. Its previous runtime is retained. The
container had been recreated since the earlier deployment, preserving the
runtime cache while restoring the upstream startup script. The local-runtime
override was restored, with that startup script backed up beside it. Verify both the startup
override and the running executable after each upgrade or container recreation.

## Release version and OpenCode 2 update

Requested on 2026-10-10.

The custom branch is rebased onto upstream main at `a8bdfdb541`, including its
OpenCode 2 fixes. Release package versions are `0.0.46` so the custom server
and clients report the expected release for compatibility. Keep server, web,
desktop, and contracts versions aligned through the release version script.
Adopt newer upstream release versions during future updates instead of keeping
this version pinned. Preserve the custom identity and continuation behavior.

The Linux CLI archive from `b57656f12a` is installed and running in
the server container. It passed isolated startup checks in the builder and target
container, and the live server reports `0.0.46` on the existing port, `3773`.
The startup override still selects the local runtime. Keep `f25cceab9f` for
rollback and preserve isolated verification before future upgrades.
