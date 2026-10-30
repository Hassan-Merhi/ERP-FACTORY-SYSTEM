/**
 * The live-query runtime policy, as installed on the app's query client:
 * live transactional queries refetch on mount and reconnect, a stale live
 * snapshot is refreshed when a page with a legacy long staleTime mounts it
 * again, and coming back online recovers legacy live queries that opted out
 * of reconnect refetches. Everything else keeps the no-refetch default.
 */
import { QueryObserver, type QueryKey } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import "@/lib/liveQueryRuntimePolicy";

const LIVE: QueryKey = ["/api/bales", { page: 1 }];
const REFERENCE: QueryKey = ["/api/locations"];
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function seed(queryKey: QueryKey, ageMs: number) {
  queryClient.setQueryData(queryKey, { rows: [] }, { updatedAt: Date.now() - ageMs });
}

function observe(queryKey: QueryKey, extra: Record<string, unknown> = {}) {
  const queryFn = vi.fn(async () => ({ rows: [1] }));
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    refetchOnMount: false,
    staleTime: 10 * 60_000,
    ...extra,
  });
  const unsubscribe = observer.subscribe(() => {});
  return { queryFn, unsubscribe };
}

beforeEach(() => queryClient.clear());
afterEach(() => queryClient.clear());

describe("live query runtime policy", () => {
  it("makes live queries, and only live queries, refetch on mount and reconnect", () => {
    const { refetchOnMount, refetchOnReconnect } = queryClient.getDefaultOptions().queries ?? {};
    const live = queryClient.getQueryCache().build(queryClient, { queryKey: LIVE });
    const reference = queryClient.getQueryCache().build(queryClient, { queryKey: REFERENCE });

    expect(typeof refetchOnMount).toBe("function");
    expect((refetchOnMount as (q: unknown) => boolean)(live)).toBe(true);
    expect((refetchOnMount as (q: unknown) => boolean)(reference)).toBe(false);
    expect((refetchOnReconnect as (q: unknown) => boolean)(live)).toBe(true);
    expect((refetchOnReconnect as (q: unknown) => boolean)(reference)).toBe(false);
  });

  it("refreshes a stale live snapshot when a legacy page mounts it", async () => {
    seed(LIVE, 60_000);
    const { queryFn, unsubscribe } = observe(LIVE);

    await tick();

    expect(queryFn).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("leaves fresh live snapshots and non-live queries alone", async () => {
    seed(LIVE, 1_000);
    seed(REFERENCE, 60 * 60_000);
    const live = observe(LIVE);
    const reference = observe(REFERENCE);

    await tick();

    expect(live.queryFn).not.toHaveBeenCalled();
    expect(reference.queryFn).not.toHaveBeenCalled();
    live.unsubscribe();
    reference.unsubscribe();
  });

  it("skips the refresh when the page unmounted before it could run", async () => {
    seed(LIVE, 60_000);
    const { queryFn, unsubscribe } = observe(LIVE);
    unsubscribe();

    await tick();

    expect(queryFn).not.toHaveBeenCalled();
  });

  it("recovers stale legacy live queries that opted out of reconnect refetches when back online", async () => {
    const legacy: QueryKey = ["/api/bales", "legacy"];
    const modern: QueryKey = ["/api/bales", "modern"];
    seed(legacy, 1_000);
    seed(modern, 1_000);
    const legacyObserver = observe(legacy, { refetchOnReconnect: false });
    const modernObserver = observe(modern, { refetchOnReconnect: true, staleTime: 1_000 });
    await tick();
    seed(legacy, 60_000);
    seed(modern, 60_000);

    window.dispatchEvent(new Event("online"));
    await tick();

    expect(legacyObserver.queryFn).toHaveBeenCalledTimes(1);
    expect(modernObserver.queryFn).not.toHaveBeenCalled();
    legacyObserver.unsubscribe();
    modernObserver.unsubscribe();
  });
});
