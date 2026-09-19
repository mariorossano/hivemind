# Fork workflow: stable and trial branches

This document describes the operating policy of this fork. It does not change
the upstream license, contribution policy, agent roles or native permissions.

## Branches

- `main` is the stable reference and fallback. It starts at the verified upstream
  commit `030bc4af0477b623fd26c28b9939561bc54b9d55`. Pending local experiments do
  not belong here. Upstream updates require review and verification before use.
- `develop` is the integration branch for changes under extended acceptance
  testing. Normal local operation should use a deliberately selected, verified
  `develop` commit; a push is not an automatic deployment or a completed trial.
- Keep each fix on a separate topic branch or in an independently reviewable
  commit. Integrate into `develop` after focused tests and at least two review
  passes on the changes. The last review must have no new actionable findings;
  fixes after a review require another review of the final result.
- Move trial work to `main` only after its acceptance criteria, extended trial
  and any required upstream coordination are complete, with an explicit decision.
  Passing unit tests alone does not promote a change to stable.

Use separate worktrees for `main` and `develop`. Do not switch branches or edit
the source underneath a running server or its MCP clients. Preserve archived
branches and uncommitted trial work until their replacement has been verified.

## Trial record

For each trial, record the objective and limits, exact source commit, relevant
adapter/launcher version, tests actually run, review results, remaining gaps,
database/configuration compatibility, backup reference and rollback procedure.
Distinguish simulated checks from real-client, browser and external-service
acceptance. A successful real-world check can begin a longer trial; it does not
automatically conclude it. A blocked or skipped test remains unverified.

Keep credentials, private operational reports, conversations and live data out
of Git. Public notes should be generic and contain no project-specific payloads.
Approval to test or move branches does not authorize unrelated publications,
merges, deployments or changes to native security controls.

## Runtime selection and rollback

Record the deployed Hivemind SHA and adapter/launcher version together. A Git
branch name can move; a running process does not automatically adopt that change.
Adapters are separately maintained software: changing only the server branch
cannot roll back a problem introduced by an adapter. Keep a known-good adapter
revision or verified private snapshot paired with each deployment.

Before a planned switch:

1. Wait for a safe idle boundary and identify the exact server/client processes.
2. Back up the database consistently, private configuration and relevant native
   conversation state. Preserve identities, models and permissions.
3. Check the target's compatibility with the current data and configuration.
   Never run two servers against the same live database, or two clients for the
   same identity, concurrently. Isolated fixtures use separate data and identities.
4. Stop the affected processes, select the intended server and adapter versions,
   then restart and verify identity, conversation continuity, delivery and UI.

When a trial fails, prefer the verified `main` deployment as fallback, but do not
assume older code can read a newer database. If a migration is incompatible, stop
and prepare a tested conversion or restoration plan. Preserve post-switch work
and reconcile it before restoring an older snapshot; never silently discard new
messages, tasks or native conversation history. Do not automatically overwrite
global client state to roll back one agent.

## GitHub automation

The upstream CI, CodeQL, Edge and Release workflows are retained unchanged and
are not disabled in this fork. A push to `main` can run checks, trigger a rolling
Edge prerelease after successful CI, and invoke release automation. These GitHub
publications do not update a local Hivemind instance.

The inherited CI/CodeQL push and pull-request branch filters target `main`, not
`develop`. Do not assume a direct `develop` push has run those checks: execute
the applicable local checks and record their results. Automation for `develop`
can be added as a separate reviewed change.

## Initial setup status — 2026-09-19

The fork is being aligned to the verified upstream baseline. The former fork
`main` is retained as `archive/main-before-upstream-20260919`. `develop` starts
from the same baseline plus this policy; no trial fixes are included yet.

The existing instance remains pinned to its verified upstream checkout during
this repository setup. Switching it to `develop` is a separate controlled step,
not a side effect of creating or publishing these branches.
