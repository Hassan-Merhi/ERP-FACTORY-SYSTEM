/**
 * The toast store behind useToast(): one toast on screen at a time, updates
 * by id, dismissal closes then removes after a delay, and every mounted hook
 * sees the same state.
 */
import { act, renderHook } from "@testing-library/react";
import { reducer, toast, useToast } from "@/hooks/use-toast";

type State = Parameters<typeof reducer>[0];
const t = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Toast ${id}`, ...extra });

// Reducer cases use ids the toast() counter never produces: dismissing queues a
// module-wide removal timer per id, which would otherwise leak into later cases.
describe("toast reducer", () => {
  const two: State = { toasts: [t("r2"), t("r1")] };

  it("keeps only the newest toast", () => {
    expect(reducer({ toasts: [t("r1")] }, { type: "ADD_TOAST", toast: t("r2") }).toasts.map((x) => x.id)).toEqual([
      "r2",
    ]);
  });

  it("updates the matching toast only", () => {
    const next = reducer(two, { type: "UPDATE_TOAST", toast: { id: "r1", title: "Saved" } });
    expect(next.toasts.map((x) => x.title)).toEqual(["Toast r2", "Saved"]);
  });

  it("closes one toast, or all of them, on dismiss", () => {
    expect(reducer(two, { type: "DISMISS_TOAST", toastId: "r1" }).toasts.map((x) => x.open)).toEqual([
      undefined,
      false,
    ]);
    expect(reducer(two, { type: "DISMISS_TOAST" }).toasts.map((x) => x.open)).toEqual([false, false]);
  });

  it("removes one toast, or all of them", () => {
    expect(reducer(two, { type: "REMOVE_TOAST", toastId: "r2" }).toasts.map((x) => x.id)).toEqual(["r1"]);
    expect(reducer(two, { type: "REMOVE_TOAST" }).toasts).toEqual([]);
  });
});

describe("toast() and useToast()", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    // The store is module-wide: close and remove whatever a test left behind.
    const { result, unmount } = renderHook(() => useToast());
    act(() => result.current.dismiss());
    act(() => {
      vi.runOnlyPendingTimers();
    });
    unmount();
    vi.useRealTimers();
  });

  it("shows a toast to every mounted hook and lets callers update it", () => {
    const first = renderHook(() => useToast());
    const second = renderHook(() => useToast());

    let handle!: ReturnType<typeof toast>;
    act(() => {
      handle = toast({ title: "Saving…" });
    });
    act(() => handle.update({ id: handle.id, title: "Saved" }));

    expect(first.result.current.toasts).toHaveLength(1);
    expect(second.result.current.toasts[0]).toMatchObject({ id: handle.id, title: "Saved", open: true });
  });

  it("closes on dismiss and removes the toast after the delay", () => {
    const { result } = renderHook(() => useToast());
    let handle!: ReturnType<typeof toast>;
    act(() => {
      handle = toast({ title: "Done" });
    });

    act(() => handle.dismiss());
    expect(result.current.toasts[0].open).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1_000_000);
    });
    expect(result.current.toasts).toEqual([]);
  });

  it("dismisses when the toast reports it was closed", () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      toast({ title: "Closable" });
    });

    act(() => result.current.toasts[0].onOpenChange?.(false));

    expect(result.current.toasts[0].open).toBe(false);
  });

  it("dismisses everything through the hook", () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      toast({ title: "One" });
    });

    act(() => result.current.dismiss());

    expect(result.current.toasts.every((x) => x.open === false)).toBe(true);
  });

  it("stops updating a hook after it unmounts", () => {
    const { result, unmount } = renderHook(() => useToast());
    unmount();
    const before = result.current.toasts.length;

    act(() => {
      toast({ title: "After unmount" });
    });

    expect(result.current.toasts).toHaveLength(before);
  });
});
