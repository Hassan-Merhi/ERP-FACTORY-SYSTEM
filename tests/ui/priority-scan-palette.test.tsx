import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PriorityScanLoadingControl } from "@/pages/factory/PriorityScanLoadingControl";
import { apiRequest } from "@/lib/queryClient";
import { translatePriorityScanText } from "@/i18n/priorityScanTranslations";
import { isApprovedPriorityScanColor, PRIORITY_SCAN_COLORS } from "@shared/priorityScanColors";

vi.mock("@/contexts/ApplicationLanguageContext", () => ({ useApplicationLanguage: () => ({ language: "en" }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));

const approved = [
  "#7FFF00",
  "#FFD700",
  "#808000",
  "#B22222",
  "#9400D3",
  "#DAA520",
  "#6A5ACD",
  "#FFB6C1",
  "#F7E7CE",
  "#614051",
  "#B0E0E6",
];
const clients: QueryClient[] = [];
const configsUrl = "/api/factory/customer-orders/loading-list/priority-scan-configs";
function mount(
  configs: Array<{ id: number; orderId: number; color: string; priority: number; enabled: boolean }> = [],
  role = "Admin"
) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false, queryFn: async () => [] } },
  });
  clients.push(client);
  client.setQueryData([configsUrl], configs);
  client.setQueryData(["/api/auth/me"], { currentRole: role });
  vi.mocked(apiRequest).mockImplementation(
    async (_method, _url, body) => new Response(JSON.stringify({ id: 1, orderId: 42, ...(body as object) }))
  );
  return render(
    <QueryClientProvider client={client}>
      <PriorityScanLoadingControl load={{ id: 42, customerName: "Test Customer", proformaIdUsed: 3 }} />
    </QueryClientProvider>
  );
}
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.clearAllMocks();
});

describe("Priority Scan fixed palette", () => {
  it("exposes exactly the approved 11 colors in order", () => {
    expect(PRIORITY_SCAN_COLORS).toEqual(approved);
    expect(new Set(PRIORITY_SCAN_COLORS).size).toBe(11);
  });

  it.each(approved)("lets a user select and save %s", async (color) => {
    mount();
    fireEvent.click(screen.getByTestId("button-set-priority-42"));
    expect(screen.getAllByRole("button", { name: /Use color/ })).toHaveLength(11);
    fireEvent.click(screen.getByRole("button", { name: `Use color ${color}` }));
    fireEvent.click(screen.getByTestId("button-save-priority-42"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        "PUT",
        "/api/factory/customer-orders/42/loading-list/priority-scan-config",
        { color, priority: 1, enabled: true }
      )
    );
  });

  it.each(["#123456", "Red", "#abc", "#dc2626", "#7FFF00 ", "red;position:absolute", "", null, 123])(
    "rejects custom palette value %s",
    (color) => {
      expect(isApprovedPriorityScanColor(color)).toBe(false);
    }
  );

  it("has no custom color or text input and accepts lowercase approved values", () => {
    mount();
    fireEvent.click(screen.getByTestId("button-set-priority-42"));
    expect(
      screen.getByRole("dialog").querySelector('input[type="color"], input[type="text"], input:not([type])')
    ).toBeNull();
    for (const color of approved) expect(isApprovedPriorityScanColor(color.toLowerCase())).toBe(true);
  });

  it("disables colors already assigned to another active loading", () => {
    mount([{ id: 2, orderId: 99, color: "#7fff00", priority: 1, enabled: true }]);
    fireEvent.click(screen.getByTestId("button-set-priority-42"));
    expect(screen.getByRole("button", { name: "Use color #7FFF00" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use color #FFD700" })).toBeEnabled();
  });

  it("cannot save when all approved colors are already active", () => {
    mount(
      approved.map((color, index) => ({
        id: index + 1,
        orderId: 100 + index,
        color,
        priority: index + 1,
        enabled: true,
      }))
    );
    fireEvent.click(screen.getByTestId("button-set-priority-42"));
    expect(screen.getByTestId("button-save-priority-42")).toBeDisabled();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("moves a legacy priority without submitting or mutating its saved color", async () => {
    const configs = [
      { id: 1, orderId: 42, color: "Navy", priority: 2, enabled: true },
      { id: 2, orderId: 99, color: "#FFD700", priority: 1, enabled: true },
    ];
    mount(configs);
    fireEvent.click(screen.getByTestId("button-priority-up-42"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        "PUT",
        "/api/factory/customer-orders/42/loading-list/priority-scan-config",
        { priority: 1, enabled: true }
      )
    );
    expect(configs[0].color).toBe("Navy");
  });

  it("saves an untouched legacy priority from the editor without recoloring it", async () => {
    mount([
      { id: 1, orderId: 42, color: "Navy", priority: 2, enabled: true },
      { id: 2, orderId: 99, color: "#FFD700", priority: 1, enabled: true },
    ]);
    fireEvent.click(screen.getByTestId("button-priority-config-42"));
    // No approved swatch is preselected in place of the saved legacy color.
    for (const color of approved) {
      expect(screen.getByRole("button", { name: `Use color ${color}` }).className).not.toContain("scale-110");
    }
    expect(screen.getByTestId("legacy-priority-color-42")).toHaveTextContent("Navy");
    fireEvent.click(screen.getByTestId("button-save-priority-42"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        "PUT",
        "/api/factory/customer-orders/42/loading-list/priority-scan-config",
        { priority: 2, enabled: true }
      )
    );
  });

  it("recolors a legacy priority only after a swatch is explicitly chosen", async () => {
    mount([{ id: 1, orderId: 42, color: "Navy", priority: 1, enabled: true }]);
    fireEvent.click(screen.getByTestId("button-priority-config-42"));
    fireEvent.click(screen.getByRole("button", { name: "Use color #B0E0E6" }));
    fireEvent.click(screen.getByTestId("button-save-priority-42"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("PUT", expect.any(String), {
        color: "#B0E0E6",
        priority: 1,
        enabled: true,
      })
    );
  });

  it("requires ordinary users to pick a swatch before saving a legacy priority", () => {
    mount([{ id: 1, orderId: 42, color: "Navy", priority: 1, enabled: true }], "User");
    fireEvent.click(screen.getByTestId("button-priority-config-42"));
    expect(screen.getByTestId("button-save-priority-42")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use color #FFD700" }));
    expect(screen.getByTestId("button-save-priority-42")).toBeEnabled();
  });

  it("requires a swatch before re-enabling an inactive legacy priority", () => {
    mount([{ id: 1, orderId: 42, color: "Navy", priority: 1, enabled: false }]);
    fireEvent.click(screen.getByTestId("button-set-priority-42"));
    expect(screen.getByTestId("button-save-priority-42")).toBeDisabled();
    expect(apiRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use color #7FFF00" }));
    expect(screen.getByTestId("button-save-priority-42")).toBeEnabled();
  });

  it("restricts ordinary users to color edits without priority controls", async () => {
    mount([{ id: 1, orderId: 42, color: "#FFD700", priority: 1, enabled: true }], "User");
    expect(screen.queryByTestId("button-priority-up-42")).toBeNull();
    fireEvent.click(screen.getByTestId("button-priority-config-42"));
    expect(screen.queryByTestId("select-priority-42")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use color #B22222" }));
    fireEvent.click(screen.getByTestId("button-save-priority-42"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("PUT", expect.any(String), { color: "#B22222", enabled: true })
    );
  });

  it.each(["en", "ar", "fr"] as const)("keeps the saved legacy color in the %s notice", (language) => {
    const notice = translatePriorityScanText("legacyPriorityColorNotice", language, { color: "#123456" });
    expect(notice).toContain("#123456");
    expect(notice).not.toContain("{color}");
    expect(notice).toContain(language === "ar" ? "الأحد عشر" : "11");
  });
});
