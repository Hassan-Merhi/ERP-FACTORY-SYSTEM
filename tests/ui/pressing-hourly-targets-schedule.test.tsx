import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PressingHourlyTargets from "@/pages/factory/PressingHourlyTargets";

const harness = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));
vi.mock("@/contexts/ApplicationLanguageContext", () => ({
  useApplicationLanguage: () => ({ language: "en" }),
  useOptionalApplicationLanguage: () => ({ language: "en" }),
}));

const ENDPOINT = "/api/factory/pressing-machines/report/hourly-targets";
const HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const allHours = (kg: number) => Object.fromEntries(HOURS.map((hour) => [String(hour), kg]));

function snapshot(canEdit: boolean) {
  return {
    day: "2026-11-09",
    serverNow: "2026-11-09T08:30:00.000Z", // Monday, Beirut
    canEdit,
    workers: [{ userId: "p1", slot: "P1", name: "P1", targetKgPerHour: 850 }],
    hours: [],
    hourlyTargetsKg: allHours(850),
    editableWeeklySchedulesKg: Object.fromEntries([1, 2, 3, 4, 5, 6].map((day) => [String(day), allHours(850)])),
    scheduledWorkday: true,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;
function mockServer(canEdit: boolean) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT") return new Response(JSON.stringify({ saved: true }), { status: 200 });
    return new Response(JSON.stringify(snapshot(canEdit)), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderTargets() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<PressingHourlyTargets active companyId={1} serverToday="2026-11-09" />, { wrapper });
}

describe("Pressing weekly KG schedule editor", () => {
  beforeEach(() => harness.toast.mockReset());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("saves one Monday–Saturday weekday with a 0 KG hour to the daily-schedule endpoint", async () => {
    mockServer(true);
    renderTargets();
    fireEvent.click(await screen.findByTestId("pressing-open-daily-schedule"));

    expect(await screen.findByText("Sunday · off")).toBeTruthy();
    expect(screen.getByText(/Use 0 KG for an hour with no required target/)).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Sunday" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Wednesday" }));
    fireEvent.change(screen.getByLabelText("Wednesday target for 11:00–12:00"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Wednesday schedule" }));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(true)
    );
    const [url, init] = fetchMock.mock.calls.find(([, call]) => (call as RequestInit | undefined)?.method === "PUT")!;
    expect(url).toBe(ENDPOINT + "/daily-schedule");
    const targetsKg = HOURS.map((hour) => (hour === 11 ? 0 : 850));
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ weekday: 3, targetsKg });
  });

  it("refuses a negative hourly value before sending anything", async () => {
    mockServer(true);
    renderTargets();
    fireEvent.click(await screen.findByTestId("pressing-open-daily-schedule"));
    fireEvent.change(await screen.findByLabelText("Monday target for 09:00–10:00"), { target: { value: "-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Monday schedule" }));
    await waitFor(() => expect(harness.toast).toHaveBeenCalled());
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("shows an hour with a 0 KG target as No target, without a percentage", async () => {
    fetchMock = vi.fn(async () => {
      const data = {
        ...snapshot(false),
        // 07:00 Beirut has finished by 10:30 Beirut; its target is 0 KG.
        hours: [{ hourStart: "2026-11-09T05:00:00.000Z", userId: "p1", kg: "120", bales: 3 }],
        hourlyTargetsKg: { ...allHours(850), "7": 0 },
      };
      return new Response(JSON.stringify(data), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderTargets();
    expect(await screen.findByText("No target")).toBeTruthy();
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("does not offer the weekly schedule to someone who cannot edit targets", async () => {
    mockServer(false);
    renderTargets();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await screen.findByText(/confirmed scans only/);
    expect(screen.queryByTestId("pressing-open-daily-schedule")).toBeNull();
  });
});
