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
- A successful response with work remaining schedules another continuation.
  Once a successful response has no remaining work, disarm without sending an
  extra prompt. Checkpoint completion must finish before that decision.
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
