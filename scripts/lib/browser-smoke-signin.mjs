/**
 * Sign-in guard shared by the browser smoke suites.
 *
 * Each suite signs in by filling the form and then waiting for the
 * authenticated shell (`#main-content`) to render. Nothing inspected the
 * sign-in response, so a rejected sign-in was indistinguishable from a slow
 * app: the wait burned its whole timeout and reported
 * "Waiting failed: <n>ms exceeded" against whichever route happened to be
 * next, with no mention of the sign-in at all.
 *
 * The rejection that actually happens is 429 from the login flood guard. The
 * suites sign in repeatedly from one CI address — the Phase 9 language sweep
 * launches a fresh browser, and so a fresh cookie jar and a real sign-in, for
 * each language times each viewport — so the budget can run out mid-run. Every
 * later viewport then waits for an app that was never going to render, which
 * is why these failures looked random, moved between routes and viewports on
 * every run, and cleared on a re-run.
 *
 * Watching the response names the cause and stops the wait as soon as the
 * server has said no.
 */

/** Records the first failed POST /api/auth/login seen on this page. */
export function watchSignInResponses(page) {
  let rejection = null;
  let markRejected;
  const rejected = new Promise((resolve) => {
    markRejected = resolve;
  });

  const listener = (response) => {
    try {
      if (response.request().method() !== "POST") return;
      if (!new URL(response.url()).pathname.endsWith("/api/auth/login")) return;
      if (response.ok()) return;
      if (rejection === null) {
        rejection = `${response.status()} ${response.statusText() || ""}`.trim();
        markRejected();
      }
    } catch {
      // A response that cannot be inspected is not evidence of a rejection.
    }
  };

  page.on("response", listener);

  return {
    get rejection() {
      return rejection;
    },
    rejected,
    stop() {
      page.off("response", listener);
    },
  };
}

/**
 * Awaits the authenticated shell, but gives up the moment the server rejects
 * the sign-in. `shellPromise` is the suite's own wait, passed in already
 * started so each suite keeps its own shell condition and timeout.
 */
export async function awaitAuthenticatedShell(watcher, shellPromise) {
  // Settled wrappers: the loser of the race must never surface as an unhandled
  // rejection once the winner has been chosen.
  const shell = shellPromise.then(
    () => ({ ok: true, error: null }),
    (error) => ({ ok: false, error }),
  );
  const outcome = await Promise.race([shell, watcher.rejected.then(() => ({ ok: false, error: null }))]);

  if (watcher.rejection !== null) {
    throw new Error(
      `sign-in rejected by the server (${watcher.rejection}) — the authenticated shell was never going to render`,
    );
  }
  if (!outcome.ok) throw outcome.error;
}
