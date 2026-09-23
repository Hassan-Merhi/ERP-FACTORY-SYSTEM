/**
 * DateFormatContext renders every date in the app. A plain `YYYY-MM-DD` value
 * (how the server sends voucher dates) must be read as a local calendar day,
 * not as UTC midnight — otherwise users west of UTC see every voucher one day
 * early. These cases run the real provider with a seeded preference.
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiRequest = vi.hoisted(() => vi.fn(async () => new Response("{}")));
vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest };
});

import { DateFormatProvider, useDateFormat } from "@/contexts/DateFormatContext";

function setup(dateFormat?: "MM/DD/YYYY" | "DD/MM/YYYY") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: () => new Promise(() => {}) } },
  });
  if (dateFormat) client.setQueryData(["/api/user-preferences"], { dateFormat });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <DateFormatProvider>{children}</DateFormatProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useDateFormat(), { wrapper });
}

beforeEach(() => apiRequest.mockClear());

describe("DateFormatContext", () => {
  it("defaults to MM/DD/YYYY and reads a bare date as a local calendar day", () => {
    const { result } = setup();
    expect(result.current.dateFormat).toBe("MM/DD/YYYY");
    expect(result.current.formatDisplayDate("2026-03-01")).toBe("03/01/2026");
    expect(result.current.formatShortDate("2026-03-01")).toBe("Mar 1, 26");
  });

  it("applies the saved DD/MM/YYYY preference", async () => {
    const { result } = setup("DD/MM/YYYY");
    await waitFor(() => expect(result.current.dateFormat).toBe("DD/MM/YYYY"));
    expect(result.current.formatDisplayDate(new Date(2026, 11, 25))).toBe("25/12/2026");
    expect(result.current.formatShortDate("2026-12-25")).toBe("25/Dec/26");
  });

  it("parses ISO timestamps and other date strings", () => {
    const { result } = setup();
    expect(result.current.formatDisplayDate("2026-07-04T10:30:00")).toBe("07/04/2026");
    expect(result.current.formatDisplayDate("July 4, 2026")).toBe("07/04/2026");
  });

  it("returns the input for unparseable dates instead of 'Invalid Date'", () => {
    const { result } = setup();
    expect(result.current.formatDisplayDate("not a date")).toBe("not a date");
    expect(result.current.formatShortDate("nope")).toBe("nope");
    expect(result.current.formatDisplayTime("nope")).toBe("");
  });

  it("formats times and combined date-times", () => {
    const { result } = setup();
    const when = new Date(2026, 0, 2, 14, 5);
    const time = when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    expect(result.current.formatDisplayTime(when)).toBe(time);
    expect(result.current.formatDisplayDateTime(when)).toBe(`01/02/2026, ${time}`);
  });

  it("switches format immediately and saves it to the server", async () => {
    const { result } = setup();
    act(() => result.current.setDateFormat("DD/MM/YYYY"));
    expect(result.current.formatDisplayDate("2026-03-01")).toBe("01/03/2026");
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("PUT", "/api/user-preferences", { dateFormat: "DD/MM/YYYY" })
    );
  });

  it("throws when used outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useDateFormat())).toThrow(/within a DateFormatProvider/);
  });
});
