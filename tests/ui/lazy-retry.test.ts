import { importWithRetry } from "@/lib/lazyRetry";

/**
 * A page chunk that fails to arrive rejects with "Failed to fetch dynamically
 * imported module", and main.tsx answers that by reloading the whole page to
 * recover from what it assumes is a stale build. For a transient failure that
 * reload is pure loss — the user is thrown out of whatever they were doing for
 * a chunk that would have arrived on a second try.
 */
describe("importWithRetry", () => {
  const page = () => null;

  it("retries a failed import and resolves without anyone noticing", async () => {
    let attempts = 0;
    const factory = () => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
      }
      return Promise.resolve({ default: page });
    };

    await expect(importWithRetry(factory)).resolves.toEqual({ default: page });
    expect(attempts).toBe(2);
  });

  it("gives up after its attempts so a genuinely missing chunk still reaches recovery", async () => {
    let attempts = 0;
    const failure = new TypeError("Failed to fetch dynamically imported module");
    const factory = () => {
      attempts += 1;
      return Promise.reject(failure);
    };

    await expect(importWithRetry(factory, 2)).rejects.toBe(failure);
    expect(attempts).toBe(2);
  });

  it("does not retry an import that succeeds", async () => {
    let attempts = 0;
    const factory = () => {
      attempts += 1;
      return Promise.resolve({ default: page });
    };

    await importWithRetry(factory);
    expect(attempts).toBe(1);
  });

  it("treats a factory that throws synchronously like any other failed attempt", async () => {
    let attempts = 0;
    const failure = new Error("chunk manifest unavailable");
    const factory = (): Promise<{ default: typeof page }> => {
      attempts += 1;
      if (attempts === 1) throw failure;
      return Promise.resolve({ default: page });
    };

    await expect(importWithRetry(factory)).resolves.toEqual({ default: page });
    expect(attempts).toBe(2);

    const alwaysThrows = (): Promise<{ default: typeof page }> => {
      throw failure;
    };
    await expect(importWithRetry(alwaysThrows, 1)).rejects.toBe(failure);
  });

  it("times out an import that never settles so the route cannot stay suspended forever", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const factory = () => {
        attempts += 1;
        return new Promise<{ default: typeof page }>(() => {});
      };

      const outcome = importWithRetry(factory, 1).then(
        () => "resolved",
        (error: Error) => error.message
      );
      await vi.advanceTimersByTimeAsync(14_999);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toBe("Page module loading timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});
