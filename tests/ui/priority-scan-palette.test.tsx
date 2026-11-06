import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PriorityScanLoadingControl } from "@/pages/factory/PriorityScanLoadingControl";
import { apiRequest } from "@/lib/queryClient";
import { translatePriorityScanText } from "@/i18n/priorityScanTranslations";
import {
  getPriorityScanLetter,
  getPriorityScanLetterInk,
  isApprovedPriorityScanColor,
  PRIORITY_SCAN_COLOR_LETTERS,
  PRIORITY_SCAN_COLORS,
} from "@shared/priorityScanColors";
import { PriorityScanColorLetter } from "@/pages/factory/PriorityScanColorLetter";

vi.mock("@/contexts/ApplicationLanguageContext", () => ({ useApplicationLanguage: () => ({ language: "en" }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/queryClient", () => ({ apiRequest: vi.fn() }));

const approved = [
  "#9400D3",
  "#F28500",
  "#FFD700",
  "#39FF14",
  "#808000",
  "#B22222",
  "#6A5ACD",
  "#000000",
  "#B0E0E6",
  "#DB7093",
  "#A7FC00",
];
const letters = ["D", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "C"] as const;
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

  it("locks unique display letters to fixed HEX values independently of queue priority", () => {
    expect(Object.keys(PRIORITY_SCAN_COLOR_LETTERS)).toEqual(approved);
    expect(new Set(Object.values(PRIORITY_SCAN_COLOR_LETTERS)).size).toBe(11);
    approved.forEach((hex, index) => {
      expect(getPriorityScanLetter(hex)).toBe(letters[index]);
      expect(getPriorityScanLetter(hex.toLowerCase())).toBe(letters[index]);
    });
    for (const legacy of ["Navy", "#dc2626", "#FFB6C1", "red", null, 1]) {
      expect(getPriorityScanLetter(legacy)).toBeNull();
    }
  });

  it("uses legible lettering on dark and light swatches", () => {
    expect(getPriorityScanLetterInk("#000000")).toBe("#FFFFFF");
    expect(getPriorityScanLetterInk("#9400D3")).toBe("#FFFFFF");
    expect(getPriorityScanLetterInk("#FFD700")).toBe("#000000");
    expect(getPriorityScanLetterInk("#A7FC00")).toBe("#000000");
  });

  it.each(approved.map((hex, index) => [hex, letters[index]] as const))(
    "renders fixed letter %s on its reusable color badge",
    (color, letter) => {
      render(<PriorityScanColorLetter color={color} />);
      const swatch = screen.getByRole("img", { name: `Priority color ${color}, letter ${letter}` });
      expect(swatch).toHaveTextContent(letter);
      expect(swatch).toHaveStyle({ backgroundColor: color });
    }
  );

  it("never invents a letter for a legacy color", () => {
    render(<PriorityScanColorLetter color="Navy" />);
    expect(screen.getByRole("img", { name: "Legacy priority color Navy" })).toBeEmptyDOMElement();
  });

  it("shows fixed letters for saved priorities without changing queue-position controls", () => {
    mount([{ id: 1, orderId: 42, color: "#9400D3", priority: 7, enabled: true }]);
    const button = screen.getByTestId("button-priority-config-42");
    expect(button).toHaveTextContent("D");
    expect(button).toHaveTextContent("#7");
    expect(screen.getByRole("img", { name: "Priority color #9400D3, letter D" })).toBeInTheDocument();
  });

  it("accepts only the fixed new palette, not removed selections", () => {
    for (const color of approved) expect(isApprovedPriorityScanColor(color)).toBe(true);
    for (const removed of ["#7FFF00", "#FFE066", "#FF00FF", "#DAA520", "#F7E7CE", "#614051", "#FFB6C1"]) {
      expect(isApprovedPriorityScanColor(removed)).toBe(false);
    }
  });

  it.each(approved)("lets a user select and save %s", async (color) => {
    mount();
    fireEvent.click(screen.getByTestId("button-set-priority-42"));
    expect(screen.getAllByRole("button", { name: /Use color/ })).toHaveLength(11);
    const swatch = screen.getByRole("button", { name: `Use color ${color}` });
    const letter = letters[approved.indexOf(color)];
    expect(swatch).toHaveTextContent(letter);
    fireEvent.click(swatch);
    expect(screen.getByText(`${letter} · ${color}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("button-save-priority-42"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith(
        "PUT",
        "/api/factory/customer-orders/42/loading-list/priority-scan-config",
        { color, priority: 1, enabled: true }
      )
    );
  });

  it.each(["#123456", "Red", "#abc", "#dc2626", "#39FF14 ", "red;position:absolute", "", null, 123])(
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
    mount([{ id: 2, orderId: 99, color: "#39ff14", priority: 1, enabled: true }]);
    fireEvent.click(screen.getByTestId("button-set-priority-42"));
    expect(screen.getByRole("button", { name: "Use color #39FF14" })).toBeDisabled();
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
    fireEvent.click(screen.getByRole("button", { name: "Use color #39FF14" }));
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
