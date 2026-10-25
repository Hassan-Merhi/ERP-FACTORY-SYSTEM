/**
 * Two output paths with no coverage until now:
 *
 * - zebraPrint: the label print mode and printer persist per browser; raw ZPL
 *   goes through QZ Tray, which is loaded on first use, connected only when
 *   its socket is closed, and explains how to fix a missing install or
 *   printer instead of failing silently.
 * - buildDetailedDaybookRows: the detailed daybook export writes one row per
 *   voucher entry (or one per voucher without entries), keeping native and
 *   historical base amounts apart and labelling legacy rows.
 */
import {
  getPrintMode,
  getPrinterName,
  isZebraMode,
  listPrinters,
  printRawZpl,
  setPrintMode,
  setPrinterName,
} from "@/lib/zebraPrint";
import { buildDetailedDaybookRows } from "@/lib/daybook-export";

type Qz = {
  security: { setCertificatePromise: ReturnType<typeof vi.fn>; setSignaturePromise: ReturnType<typeof vi.fn> };
  websocket: { isActive: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> };
  printers: { find: ReturnType<typeof vi.fn> };
  configs: { create: ReturnType<typeof vi.fn> };
  print: ReturnType<typeof vi.fn>;
};
type QzWindow = Window & { qz?: Qz };

function fakeQz(active = true): Qz {
  return {
    security: { setCertificatePromise: vi.fn(), setSignaturePromise: vi.fn() },
    websocket: { isActive: vi.fn(() => active), connect: vi.fn(async () => {}) },
    printers: { find: vi.fn(async () => ["ZD420", "Office"]) },
    configs: { create: vi.fn((printer: string) => ({ printer })) },
    print: vi.fn(async () => {}),
  };
}

/** Answers the next QZ Tray script tag: loads `qz` (or nothing), or fails. */
function onScript(outcome: "load" | "empty" | "error", qz = fakeQz()) {
  const append = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
    const script = node as HTMLScriptElement;
    queueMicrotask(() => {
      if (outcome === "error") return script.onerror?.(new Event("error"));
      if (outcome === "load") (window as QzWindow).qz = qz;
      script.onload?.(new Event("load"));
    });
    return append(node);
  });
  return qz;
}

beforeEach(() => {
  localStorage.clear();
  delete (window as QzWindow).qz;
});
afterEach(() => {
  vi.restoreAllMocks();
  document.head.querySelectorAll("script").forEach((script) => script.remove());
  delete (window as QzWindow).qz;
});

describe("label print settings", () => {
  it("defaults to browser printing with no printer, and remembers both choices", () => {
    expect(getPrintMode()).toBe("BROWSER");
    expect(isZebraMode()).toBe(false);
    expect(getPrinterName()).toBe("");

    setPrintMode("ZEBRA_RAW");
    setPrinterName("ZD420");

    expect(getPrintMode()).toBe("ZEBRA_RAW");
    expect(isZebraMode()).toBe(true);
    expect(getPrinterName()).toBe("ZD420");
  });
});

describe("QZ Tray printing", () => {
  it("loads QZ Tray once, trusts it unsigned, and lists printers", async () => {
    const qz = onScript("load");

    await expect(listPrinters()).resolves.toEqual(["ZD420", "Office"]);
    expect(document.head.querySelector("script")?.getAttribute("src")).toBe(
      "https://cdn.jsdelivr.net/npm/qz-tray@2/qz-tray.min.js"
    );
    expect(qz.security.setCertificatePromise).toHaveBeenCalledTimes(1);
    expect(await qz.security.setSignaturePromise.mock.calls[0][0]()).toBe("");

    await listPrinters();
    expect(document.head.querySelectorAll("script")).toHaveLength(1);
  });

  it.each([
    ["the script cannot load", "error" as const, "Failed to load QZ Tray script"],
    ["the library is missing after loading", "empty" as const, "QZ Tray library failed to load"],
  ])("fails clearly when %s", async (_label, outcome, message) => {
    onScript(outcome);

    await expect(listPrinters()).rejects.toThrow(message);
  });

  it("connects a closed socket, and explains a connection failure", async () => {
    const qz = fakeQz(false);
    (window as QzWindow).qz = qz;

    await listPrinters();
    expect(qz.websocket.connect).toHaveBeenCalledTimes(1);

    qz.websocket.connect.mockRejectedValueOnce(new Error("refused"));
    await expect(listPrinters()).rejects.toThrow(/Make sure QZ Tray is installed and running.*Error: refused/);
  });

  it("prints raw ZPL to the given or saved printer", async () => {
    const qz = fakeQz();
    (window as QzWindow).qz = qz;

    await printRawZpl("^XA^XZ", "Office");
    setPrinterName("ZD420");
    await printRawZpl("^XA^FDx^XZ");

    expect(qz.configs.create.mock.calls).toEqual([
      ["Office", { altPrinting: false }],
      ["ZD420", { altPrinting: false }],
    ]);
    // The socket was already open: never reconnect it.
    expect(qz.websocket.connect).not.toHaveBeenCalled();
    expect(qz.print).toHaveBeenLastCalledWith({ printer: "ZD420" }, [
      { type: "raw", format: "plain", data: "^XA^FDx^XZ" },
    ]);
  });

  it("refuses to print without a printer", async () => {
    const qz = fakeQz();
    (window as QzWindow).qz = qz;

    await expect(printRawZpl("^XA^XZ")).rejects.toThrow("No Zebra printer selected");
    expect(qz.print).not.toHaveBeenCalled();
  });
});

describe("detailed daybook export", () => {
  const formatDate = (date: string | Date) => `d:${String(date)}`;

  it("writes one row per entry with native and historical base amounts", () => {
    const rows = buildDetailedDaybookRows(
      [
        {
          voucherNumber: "JV-1",
          voucherDate: "2026-10-01",
          voucherType: "Journal",
          description: "Month end",
          currency: "ZMW",
          exchangeRate: 27,
          entries: [
            {
              narration: "Rent",
              accountName: "Rent expense",
              transactionCurrency: "USD",
              transactionDebitAmount: 10,
              baseDebitAmount: 270,
              historicalExchangeRate: 27,
              currencyStatus: "HISTORICAL_BASE",
            },
            { creditAmount: 5, baseDebitAmount: null },
          ],
        },
      ],
      formatDate
    );

    expect(rows).toEqual([
      {
        "Voucher Number": "JV-1",
        Date: "d:2026-10-01",
        Type: "Journal",
        Description: "Rent",
        Account: "Rent expense",
        Currency: "USD",
        "Native Debit": 10,
        "Native Credit": "",
        "Historical Base Debit": 270,
        "Historical Base Credit": "",
        "Historical Exchange Rate": 27,
        "Currency Status": "HISTORICAL_BASE",
      },
      {
        "Voucher Number": "JV-1",
        Date: "d:2026-10-01",
        Type: "Journal",
        Description: "Month end",
        Account: "",
        Currency: "ZMW",
        "Native Debit": "",
        "Native Credit": 5,
        "Historical Base Debit": "",
        "Historical Base Credit": "",
        "Historical Exchange Rate": 27,
        "Currency Status": "LEGACY_BASE",
      },
    ]);
  });

  it("labels an entry with a base amount as historical, and defaults the currency to USD", () => {
    const [row] = buildDetailedDaybookRows(
      [{ voucherNumber: "PV-2", voucherDate: "x", entries: [{ debitAmount: 3, baseDebitAmount: 3 }] }],
      formatDate
    );

    expect(row).toMatchObject({
      Currency: "USD",
      "Native Debit": 3,
      "Historical Exchange Rate": "",
      "Currency Status": "HISTORICAL_BASE",
    });
  });

  it("writes one row for a voucher without entries", () => {
    const rows = buildDetailedDaybookRows(
      [
        { voucherNumber: "RV-3", voucherDate: "y", voucherType: "Receipt", transactionCurrency: "CFA" },
        {
          voucherNumber: "RV-4",
          voucherDate: "z",
          entries: "not a list",
          description: "Cash",
          currency: "EUR",
          transactionDebitAmount: 1,
          transactionCreditAmount: 2,
          baseDebitAmount: 3,
          baseCreditAmount: 4,
          currencyStatus: "HISTORICAL_BASE",
        },
      ],
      formatDate
    );

    expect(rows).toEqual([
      {
        "Voucher Number": "RV-3",
        Date: "d:y",
        Type: "Receipt",
        Description: "",
        Currency: "CFA",
        "Native Debit": "",
        "Native Credit": "",
        "Historical Base Debit": "",
        "Historical Base Credit": "",
        "Currency Status": "LEGACY_BASE",
      },
      {
        "Voucher Number": "RV-4",
        Date: "d:z",
        Type: undefined,
        Description: "Cash",
        Currency: "EUR",
        "Native Debit": 1,
        "Native Credit": 2,
        "Historical Base Debit": 3,
        "Historical Base Credit": 4,
        "Currency Status": "HISTORICAL_BASE",
      },
    ]);
    expect(buildDetailedDaybookRows([{ voucherNumber: "X" }], formatDate)[0].Currency).toBe("USD");
  });
});
