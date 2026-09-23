/**
 * Payroll & Benefits → Attendance, rendered with a day's records.
 *
 * Replaces source-text assertions on FactoryAttendance.tsx (a god file), so the
 * page can be split without breaking these checks: the controls a user works
 * with, the absence of the per-screen shift picker and WhatsApp group editor
 * (the group lives in Intel Settings), and the KPI strip that goes into the
 * WhatsApp attendance image.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState } from "./pageMocks";

const sent = vi.hoisted(() => ({ calls: [] as Array<{ method: string; url: string; body?: any }> }));

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);
vi.mock("@/contexts/LocationContext", async () => (await import("./pageMocks")).locationContextMock);
vi.mock("@/contexts/CursorNavContext", async () => (await import("./pageMocks")).cursorNavMock);
vi.mock("html2canvas", () => ({
  default: vi.fn(async () => ({ toDataURL: () => "data:image/png;base64,AAAA" })),
}));
vi.mock("@/lib/factoryApi", () => ({
  factoryApiRequest: vi.fn(async (method: string, url: string, body?: unknown) => {
    sent.calls.push({ method, url, body });
    const payload = url.startsWith("/api/factory/settings") ? { attendanceWhatsappGroupId: "group-1" } : { ok: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }),
}));

const workers = [
  { id: 1, fullName: "Amal Present", employeeCode: "W1", department: null, position: null, shiftType: null },
  { id: 2, fullName: "Bilal Absent", employeeCode: "W2", department: null, position: null, shiftType: null },
  { id: 3, fullName: "Carla Late", employeeCode: "W3", department: null, position: null, shiftType: null },
];

function record(workerId: number, status: string) {
  return { id: workerId, workerId, attendanceDate: "2026-09-23", shift: null, status, notes: null };
}

beforeEach(() => {
  resetPageState();
  pageState.companyType = "factory";
  pageState.appMode = "factory";
  sent.calls.length = 0;
  (global as any).fetch = vi.fn(async (url: string) => {
    const body = String(url).startsWith("/api/factory/attendance?")
      ? { workers, attendance: [record(1, "Present"), record(2, "Absent"), record(3, "Late")] }
      : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
});

async function renderAttendance() {
  const { default: FactoryAttendance } = await import("@/pages/factory/FactoryAttendance");
  const view = renderWithProviders(<FactoryAttendance />);
  await screen.findByTestId("select-status-1");
  return view;
}

describe("Factory attendance", () => {
  it("shows the day's controls without a shift picker or WhatsApp group editor", async () => {
    const { container } = await renderAttendance();

    expect(container.querySelector(".factory-tracking-modern.factory-tracking-attendance")).not.toBeNull();
    for (const id of [
      "input-attendance-date",
      "button-send-attendance-whatsapp-image",
      "button-actions-dropdown",
      "button-save-attendance",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    for (const worker of workers) {
      expect(screen.getByTestId(`select-status-${worker.id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`input-notes-${worker.id}`)).toBeInTheDocument();
    }

    expect(screen.queryByTestId("input-shift")).toBeNull();
    expect(screen.queryByTestId("button-change-attendance-whatsapp-group")).toBeNull();
    expect(screen.queryByTestId("button-save-attendance-wa-group")).toBeNull();
  });

  it("offers range export and print from the actions menu", async () => {
    await renderAttendance();
    const trigger = screen.getByTestId("button-actions-dropdown");
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
      fireEvent.click(trigger);
    });
    await waitFor(() => expect(document.querySelector('[data-testid="button-range-export-excel"]')).not.toBeNull());
    expect(document.querySelector('[data-testid="button-range-print"]')).not.toBeNull();
  });

  it("counts the day's statuses into the WhatsApp image KPIs", async () => {
    await renderAttendance();
    const kpis = screen.getByTestId("attendance-report-kpis");
    const value = (key: string) => within(kpis).getByTestId(`attendance-report-kpi-${key}`).textContent;

    await waitFor(() => expect(value("absent")).toContain("1"));
    expect(value("total")).toMatch(/Total\s*3|3\s*Total/);
    expect(value("present")).toContain("1");
    expect(value("other")).toContain("1");
  });

  it("sends the attendance image to the attendance WhatsApp destination", async () => {
    await renderAttendance();
    await waitFor(() => expect(screen.getByTestId("button-send-attendance-whatsapp-image")).not.toBeDisabled());

    await act(async () => {
      fireEvent.click(screen.getByTestId("button-send-attendance-whatsapp-image"));
    });

    await waitFor(() =>
      expect(sent.calls.find((call) => call.url === "/api/factory/send-mix-batch-image-whatsapp")).toBeDefined()
    );
    const call = sent.calls.find((entry) => entry.url === "/api/factory/send-mix-batch-image-whatsapp")!;
    expect(call.body).toMatchObject({
      destination: "attendance",
      imageBase64: "data:image/png;base64,AAAA",
      caption: expect.stringContaining("Attendance Report"),
    });
  });
});
