#!/bin/bash
set -e

# Install the dependencies pinned by the merged lockfile. `npm ci` installs
# exactly what package-lock.json records instead of re-resolving versions.
npm ci --legacy-peer-deps

# NOTE: We deliberately do NOT run `drizzle-kit push` here.
#
# The schema source-of-truth in this project is the runtime `migrations`
# array in server/index.ts (idempotent DO blocks + CREATE INDEX/TABLE IF NOT
# EXISTS). Every DDL change is added there and runs automatically on boot —
# including post-merge when the workflow restarts.
#
# `drizzle-kit push` is interactive and prompts for ambiguous column-rename
# detections (e.g. fiscal_period_closures.period_start_date vs renamed-from
# period_start/period_end/closed_at/closed_by). With stdin closed in the
# post-merge harness the prompt EOFs and setup fails. Worse, even piping
# `yes ""` doesn't unstick it because kit uses raw TTY input. Since the
# runtime migrations cover the same ground (and have been applied to dev
# already by the merging task agent), skipping kit here is safe.
#
# If a future task needs explicit kit-driven schema sync, run it manually
# in a foreground shell where the rename prompts can be answered.

echo "post-merge: dependencies installed, schema sync deferred to runtime migrations array"
