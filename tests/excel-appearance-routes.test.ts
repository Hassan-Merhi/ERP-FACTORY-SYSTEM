import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EXCEL_APPEARANCE_SETTINGS } from "../shared/universal-excel/appearanceSettings";

const mocked = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  requireRole: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: mocked.requireRole,
}));
vi.mock("../server/storage", () => ({
  storage: { getCompanyById: vi.fn(async (id: number) => ({ id, name: "Company " + id })) },
}));
vi.mock("../server/services/excelAppearanceSettings", () => ({
  canManageExcelAppearance: (role: string) => role === "Admin" || role === "Developer",
  loadCompanyExcelAppearance: mocked.load,
  saveCompanyExcelAppearance: mocked.save,
}));

import { registerExcelAppearanceRoutes } from "../server/routes/excelAppearanceRoutes";

type Handler = (req: any, res: any) => Promise<unknown>;
function harness() {
  const handlers = new Map<string, Handler>();
  const app = {
    get: (path: string, ...args: unknown[]) => handlers.set("GET " + path, args.at(-1) as Handler),
    put: (path: string, ...args: unknown[]) => handlers.set("PUT " + path, args.at(-1) as Handler),
  };
  registerExcelAppearanceRoutes(app as never);
  const response = () => {
    const res = {
      statusCode: 200,
      status: vi.fn((status: number) => {
        res.statusCode = status;
        return res;
      }),
      setHeader: vi.fn(),
      json: vi.fn((payload: unknown) => payload),
    };
    return res;
  };
  return { handlers, response };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocked.load.mockResolvedValue(DEFAULT_EXCEL_APPEARANCE_SETTINGS);
  mocked.save.mockResolvedValue(DEFAULT_EXCEL_APPEARANCE_SETTINGS);
});

describe("Excel appearance API per-company and active-role boundaries", () => {
  it("registers Admin/Developer write guard, excluding Owner and View-Only", () => {
    harness();
    expect(mocked.requireRole).toHaveBeenCalledWith("Admin", "Developer");
  });

  it("reads only the session-selected company, never a supplied company ID", async () => {
    const { handlers, response } = harness();
    const res = response();
    await handlers.get("GET /api/excel-export/appearance")!(
      {
        session: { currentCompanyId: 7, currentRole: "POS" },
        query: { companyId: "99" },
      },
      res
    );
    expect(mocked.load).toHaveBeenCalledWith(7);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        appearance: DEFAULT_EXCEL_APPEARANCE_SETTINGS,
        companyName: "Company 7",
      })
    );
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("rejects View-Only role even if the base user originally has Admin access", async () => {
    const { handlers, response } = harness();
    const res = response();
    await handlers.get("PUT /api/excel-export/appearance")!(
      {
        session: { currentCompanyId: 7, currentRole: "View Only" },
        user: { role: "Admin" },
        body: DEFAULT_EXCEL_APPEARANCE_SETTINGS,
      },
      res
    );
    expect(res.statusCode).toBe(403);
    expect(mocked.save).not.toHaveBeenCalled();
  });

  it("writes only the current company for active Admin, never a body companyId", async () => {
    const { handlers, response } = harness();
    const res = response();
    await handlers.get("PUT /api/excel-export/appearance")!(
      {
        session: { currentCompanyId: 2, currentRole: "Admin" },
        body: DEFAULT_EXCEL_APPEARANCE_SETTINGS,
      },
      res
    );
    expect(mocked.save).toHaveBeenCalledWith(2, DEFAULT_EXCEL_APPEARANCE_SETTINGS);
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 when the session has no selected company", async () => {
    const { handlers, response } = harness();
    const res = response();
    await handlers.get("PUT /api/excel-export/appearance")!(
      {
        session: { currentCompanyId: null, currentRole: "Developer" },
        body: DEFAULT_EXCEL_APPEARANCE_SETTINGS,
      },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(mocked.save).not.toHaveBeenCalled();
  });
});
