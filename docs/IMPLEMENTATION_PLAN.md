# Bring your own agent: implementation plan

## Stage 1: Outside token route
**Goal**: `POST /api/forks/:repo/token` mints a 1 hour write token for the owner's fork.
**Success Criteria**: owner only, quotas per user and per client, one live outside token per fork, token never logged.
**Tests**: response shape and commands, TTL, revoke of the previous token, quota values.
**Status**: Complete

## Stage 2: main protection
**Goal**: a push to `main` that the platform did not make is undone and its commits moved to a work branch.
**Success Criteria**: every platform push to main is approved first; the consumer restores main for outside pushes.
**Tests**: push classification, restore plan, approval names.
**Status**: Complete

## Stage 3: Drafted intent for outside pushes
**Goal**: the gate drafts `.intent/<id>.json` (source `outside-push`) for a pushed branch that carries none, then gates the drafted commit.
**Success Criteria**: tier 3 runs on the drafted commit; harvest reads the record.
**Tests**: changed files, commit messages, draft record, detection of an existing record, harvestable.
**Status**: Complete

## Stage 4: Concurrency with a customize run
**Goal**: an outside push that lands while a customize run is in flight is re-merged or rejected cleanly and shown in the timeline.
**Tests**: disjoint change re-merged and regated; same file conflict rejected; recipe replanned on moved main.
**Status**: Complete

## Stage 5: UI, mock mode, docs
**Goal**: "Connect your own agent" panel, mock token route and simulated outside push, docs.
**Tests**: command builder and countdown text.
**Status**: Not Started
