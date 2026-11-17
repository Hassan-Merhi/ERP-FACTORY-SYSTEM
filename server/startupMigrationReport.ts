/**
 * Startup-migration outcome, readable by the health surface.
 *
 * Why this exists
 * ---------------
 * `runMigrations()` collected its failures in a local array, logged them at
 * ERROR, and then set `migrationsDone = true` in a `finally` regardless of the
 * outcome. `/api/health/db` reported `{"status":"ok","message":"Database
 * ready"}` off that flag alone, so a startup with fifteen failed migrations was
 * indistinguishable from a clean one.
 *
 * That mattered because `.github/workflows/ci.yml` gates the entire backend
 * suite on that endpoint (`if: steps.runtime_migrations.outcome == 'success'`),
 * and the step succeeds as soon as the endpoint answers. A broken migration
 * therefore passed CI silently — the tests ran against whatever schema
 * survived.
 *
 * The failures stay non-fatal: the server is deliberately built to start and
 * serve against a partial schema rather than refuse traffic, and that behaviour
 * is not changed here. What changes is that the outcome is now reported, so a
 * gate can be built on it.
 */

export interface StartupMigrationFailure {
  sql: string;
  error: string;
}

interface StartupMigrationReport {
  completed: boolean;
  skipped: boolean;
  failureCount: number;
  failures: StartupMigrationFailure[];
}

const report: StartupMigrationReport = {
  completed: false,
  skipped: false,
  failureCount: 0,
  failures: [],
};

/** Records the failures collected by a startup migration pass. */
export function recordStartupMigrationFailures(failures: StartupMigrationFailure[]): void {
  report.failures = failures.map(({ sql, error }) => ({ sql, error }));
  report.failureCount = report.failures.length;
}

/** Marks the boot-time data operations finished (the schema was verified before boot). */
export function markStartupMigrationsComplete(options: { skipped?: boolean } = {}): void {
  report.completed = true;
  if (options.skipped) report.skipped = true;
}

/** Snapshot for the health surface. Returns a copy so callers cannot mutate it. */
export function getStartupMigrationReport(): StartupMigrationReport {
  return {
    completed: report.completed,
    skipped: report.skipped,
    failureCount: report.failureCount,
    failures: report.failures.map(({ sql, error }) => ({ sql, error })),
  };
}
