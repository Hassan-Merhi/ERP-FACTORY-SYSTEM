/**
 * Rendering paths of server/lib/accountStatementPdfGenerator.ts: voucher
 * grouping, historical memo rows, supplier versus debtor running balances,
 * period labels, currency symbols, RTL and mixed Arabic text, logos, and page
 * breaks. The data-loading step and the company lookups are stubbed at their
 * module boundary so each case controls exactly what is drawn.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMoney } from "../server/lib/money";

const harness = vi.hoisted(() => ({
  step: null as unknown,
  company: { name: "Acme", baseCurrency: "USD" } as Record<string, unknown> | undefined,
  settings: { logoUrl: null } as Record<string, unknown> | undefined,
}));

vi.mock("../server/lib/accountStatementPdfGeneratorStep", () => ({
  accountStatementPdfGeneratorStep: vi.fn(async () => harness.step),
}));
vi.mock("../server/storage", () => ({
  storage: {
    getCompanyById: vi.fn(async () => harness.company),
    getCompanySettings: vi.fn(async () => harness.settings),
  },
}));

import { generateAccountStatementPdf } from "../server/lib/accountStatementPdfGenerator";

const EN = {
  from: "From",
  upTo: "Up to",
  allTime: "All time",
  accountStatement: "Account Statement",
  period: "Period",
  generated: "Generated",
  colDate: "DATE",
  colParticulars: "PARTICULARS",
  colDebit: "DEBIT",
  colCredit: "CREDIT",
  colBalance: "BALANCE",
  openingBalance: "Opening Balance",
  periodTotal: "Period Total",
  closingBalance: "Closing Balance",
  dr: "Dr",
  cr: "Cr",
};
const AR = {
  ...EN,
  accountStatement: "كشف حساب",
  colDate: "التاريخ",
  colParticulars: "البيان",
  colDebit: "مدين",
  colCredit: "دائن",
  colBalance: "الرصيد",
};

type Entry = {
  voucherId: number;
  voucherNumber: string | null;
  voucherType: string | null;
  voucherDate: string | null;
  voucherDescription: string | null;
  narration: string | null;
  debitAmount: string | null;
  creditAmount: string | null;
};

const entry = (voucherId: number, over: Partial<Entry> = {}): Entry => ({
  voucherId,
  voucherNumber: `V-${voucherId}`,
  voucherType: "Journal",
  voucherDate: "2026-03-01",
  voucherDescription: null,
  narration: null,
  debitAmount: "0",
  creditAmount: "0",
  ...over,
});

function setStep(over: Record<string, unknown> = {}) {
  const opening = (over.openingBalance as number | undefined) ?? 100;
  harness.step = {
    companyId: 1,
    startDate: undefined,
    endDate: undefined,
    t: EN,
    isRTL: false,
    isSupplier: false,
    rawEntries: [],
    accountName: "Customer A",
    historicalMemo: [],
    openingBalanceExact: toMoney(opening),
    openingBalance: opening,
    ...over,
  };
}

const pages = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
const render = () => generateAccountStatementPdf({ accountType: "customer", accountId: 1, companyId: 1 });

beforeEach(() => {
  harness.company = { name: "Acme", baseCurrency: "USD" };
  harness.settings = { logoUrl: null };
});

describe("generateAccountStatementPdf rendering", () => {
  it("renders a one-page customer statement with grouped vouchers and memo rows", async () => {
    setStep({
      startDate: "2026-02-01",
      endDate: "2026-04-30",
      rawEntries: [
        entry(1, { debitAmount: "50.5" }),
        entry(1, { creditAmount: "10", narration: "second line" }),
        entry(2, {
          voucherDescription: "Sale",
          creditAmount: "1000",
          voucherNumber: null,
          voucherType: null,
          voucherDate: null,
        }),
        entry(3, { narration: "same day", voucherNumber: "A-1" }),
      ],
      historicalMemo: [
        { date: "2026-01-15", amount: "5", reference: "OLD", label: "before window" },
        { date: "2026-03-02", amount: null, reference: null, label: "no amount" },
        { date: "2026-03-03", amount: "25", reference: "INV-1", label: "memo debit" },
        { date: "2026-03-04", amount: "-7.25", reference: null, label: "memo credit" },
      ],
    });
    const pdf = await render();
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pages(pdf)).toBe(1);
  });

  it("renders a supplier statement with a negative opening, start-only period and an unknown currency", async () => {
    harness.company = { name: "Acme", baseCurrency: "zzz" };
    setStep({
      isSupplier: true,
      openingBalance: -40,
      startDate: "2026-01-01",
      rawEntries: [entry(4, { debitAmount: "60" })],
    });
    expect(pages(await render())).toBe(1);
    harness.company = undefined;
    harness.settings = undefined;
    setStep({
      isSupplier: true,
      openingBalance: 30,
      endDate: "2026-05-01",
      rawEntries: [entry(5, { creditAmount: "1234.5" })],
    });
    expect(pages(await render())).toBe(1);
    setStep({ openingBalance: -1, rawEntries: [entry(6, { creditAmount: "10" })] });
    expect(pages(await render())).toBe(1);
  });

  it("renders right-to-left with Arabic labels and Arabic narration in a left-to-right statement", async () => {
    harness.company = { name: "شركة", baseCurrency: "AED" };
    setStep({
      t: AR,
      isRTL: true,
      accountName: "عميل",
      rawEntries: [entry(7, { narration: "دفعة", debitAmount: "9" })],
    });
    expect(pages(await render())).toBe(1);
    setStep({ rawEntries: [entry(8, { narration: "Payment دفعة", debitAmount: "9" })] });
    expect(pages(await render())).toBe(1);
  });

  it("uses the company logo when the file exists and falls back otherwise", async () => {
    harness.settings = { logoUrl: "/server/hmd-logo.png" };
    setStep();
    expect(pages(await render())).toBe(1);
    harness.settings = { logoUrl: "/server/fonts/Amiri-Regular.ttf" };
    expect(pages(await render())).toBe(1);
    harness.settings = { logoUrl: "/does/not/exist.png" };
    expect(pages(await render())).toBe(1);
    harness.settings = { logoUrl: "https://example.test/logo.png" };
    expect(pages(await render())).toBe(1);
  });

  it("breaks long statements across pages and repeats the header", async () => {
    const rawEntries = Array.from({ length: 120 }, (_, i) =>
      entry(100 + i, { debitAmount: String(i + 1), voucherDate: `2026-03-${String((i % 28) + 1).padStart(2, "0")}` })
    );
    setStep({ rawEntries });
    expect(pages(await render())).toBeGreaterThanOrEqual(3);
  });
});
