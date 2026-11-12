import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  company: null as null | { selectedCompany: { id: number } },
  query: null as null | {
    queryKey: readonly unknown[];
    enabled: boolean;
    staleTime: number;
    queryFn: () => Promise<Array<{ previewUrl: string }>>;
  },
  data: undefined as undefined | Array<{ value: string; label: string; color: string }>,
  loading: false,
  refetch: vi.fn(),
  setBannerTimestamps: vi.fn(),
}));

vi.mock("@/contexts/CompanyContext", () => ({
  useOptionalCompany: () => fixture.company,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (config: NonNullable<typeof fixture.query>) => {
    fixture.query = config;
    return { data: fixture.data, isLoading: fixture.loading, refetch: fixture.refetch };
  },
}));
vi.mock("@/lib/labelHtml", () => ({
  A4_DESIGN_OPTIONS: [
    { value: "blue", label: "Blue", color: "#165bb6", previewUrl: "/labels/previews/hmd-blue-preview.webp" },
  ],
  setBannerTimestamps: fixture.setBannerTimestamps,
}));

import { useLabelDesignColors } from "./useLabelDesignColors";

function getQuery(): NonNullable<typeof fixture.query> {
  const query = fixture.query;
  if (!query) throw new Error("Expected a mocked query configuration");
  return query;
}

describe("useLabelDesignColors", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.company = null;
    fixture.query = null;
    fixture.data = undefined;
    fixture.loading = false;
  });

  it("provides static defaults and disables the query without a company", () => {
    const result = useLabelDesignColors();
    expect(getQuery().queryKey).toEqual(["/api/factory/label-design-colors", "no-company"]);
    expect(getQuery().enabled).toBe(false);
    expect(getQuery().staleTime).toBe(30_000);
    expect(result.colors).toEqual([
      expect.objectContaining({ value: "blue", isDefault: true, hasCustom: false, lastModified: null }),
    ]);
    expect(result.isLoading).toBe(false);
    expect(result.refetch).toBe(fixture.refetch);
  });

  it("scopes queries to the active company and exposes query data/loading", () => {
    fixture.company = { selectedCompany: { id: 18 } };
    fixture.data = [{ value: "violet", label: "Violet", color: "#404040" }];
    fixture.loading = true;
    const result = useLabelDesignColors();
    expect(getQuery().queryKey).toEqual(["/api/factory/label-design-colors", 18]);
    expect(getQuery().enabled).toBe(true);
    expect(result.colors).toBe(fixture.data);
    expect(result.isLoading).toBe(true);
  });

  it("transforms default and custom rows and publishes only valid custom timestamps", async () => {
    fixture.company = { selectedCompany: { id: 7 } };
    useLabelDesignColors();
    const rows = [
      {
        id: 1,
        slug: "navy",
        label: "Navy",
        colorHex: "#123456",
        isDefault: false,
        hasCustom: true,
        lastModified: 123456,
      },
      {
        id: 2,
        slug: "blue",
        label: "Blue",
        colorHex: "#165bb6",
        isDefault: true,
        hasCustom: false,
        lastModified: null,
      },
      { id: 3, slug: "royal", label: "Royal", colorHex: "#223344", isDefault: false, hasCustom: true, lastModified: 0 },
      {
        id: 4,
        slug: "indigo",
        label: "Indigo",
        colorHex: "#336699",
        isDefault: true,
        hasCustom: false,
        lastModified: 5432,
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue(rows) });
    vi.stubGlobal("fetch", fetchMock);
    const result = await getQuery().queryFn();
    expect(fetchMock).toHaveBeenCalledWith("/api/factory/label-design-colors", { credentials: "include" });
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({
      id: 1,
      slug: "navy",
      value: "navy",
      label: "Navy",
      color: "#123456",
      colorHex: "#123456",
      previewUrl: "/labels/hmd-navy.jpg?t=123456",
      isDefault: false,
      hasCustom: true,
      lastModified: 123456,
    });
    expect(result[1].previewUrl).toBe("/labels/previews/hmd-blue-preview.webp");
    expect(result[2].previewUrl).toBe("/labels/previews/hmd-royal-preview.webp");
    expect(result[3].previewUrl).toBe("/labels/previews/hmd-indigo-preview.webp");
    expect(fixture.setBannerTimestamps).toHaveBeenCalledWith({ navy: 123456, blue: null, royal: null, indigo: null });
  });

  it("uses the static palette if the server response is not an array", async () => {
    useLabelDesignColors();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue({ error: "unexpected" }) }));
    const values = await getQuery().queryFn();
    expect(values).toEqual([expect.objectContaining({ value: "blue", isDefault: true })]);
    expect(fixture.setBannerTimestamps).toHaveBeenCalledWith({ blue: null });
  });

  it("preserves an intentionally empty server-provided palette", async () => {
    useLabelDesignColors();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: vi.fn().mockResolvedValue([]) }));
    expect(await getQuery().queryFn()).toEqual([]);
    expect(fixture.setBannerTimestamps).toHaveBeenCalledWith({});
  });
});
