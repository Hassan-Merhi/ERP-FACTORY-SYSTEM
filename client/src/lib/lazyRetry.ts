import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type ModuleFactory<T> = () => Promise<{ default: T }>;

const DEFAULT_ATTEMPTS = 3;
const BASE_DELAY_MS = 300;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function importWithRetry<T>(
  factory: ModuleFactory<T>,
  attempts: number = DEFAULT_ATTEMPTS
): Promise<{ default: T }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await factory();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(BASE_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

/**
 * React.lazy that retries the dynamic import before giving up.
 *
 * A page chunk that fails to arrive — a dropped connection, a request the
 * browser cancelled, a slow proxy — rejects with "Failed to fetch dynamically
 * imported module". main.tsx treats that as a stale-asset build and recovers by
 * reloading the whole page, which is right after a deploy and far too heavy for
 * a blip: the user loses their place for a chunk that would have arrived on a
 * second try.
 *
 * Retrying first keeps a transient failure invisible — the chunk simply loads a
 * moment later. A chunk that is genuinely gone still exhausts its attempts and
 * still reaches the recovery path, so deploys behave exactly as before.
 */
type LoadableComponent = ComponentType<Record<string, unknown>>;

type LazyResult<T> = T extends ComponentType<infer Props> ? LazyExoticComponent<ComponentType<Props>> : never;

export function lazyRetry<T>(factory: ModuleFactory<T>, attempts: number = DEFAULT_ATTEMPTS): LazyResult<T> {
  const load = async (): Promise<{ default: LoadableComponent }> =>
    (await importWithRetry(factory, attempts)) as unknown as { default: LoadableComponent };

  return lazy(load) as unknown as LazyResult<T>;
}
