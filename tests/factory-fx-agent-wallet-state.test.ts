import { describe, expect, it } from "vitest";
import {
  conversionPreview,
  settlementPreview,
  replayFxAgentWallet,
  walletCurrentUsd,
} from "../server/services/factory/fxAgentWalletState";

describe("FX agent EUR settlement and Net Position", () => {
  const quote = conversionPreview("10000", "1.1115");

  it("keeps the agreed conversion and historical USD basis independently", () => {
    expect(quote.eur).toBe("8996.851102");
    const state = replayFxAgentWallet("10000", [
      {
        kind: "USD_TO_EUR",
        sourceAmount: quote.usd,
        targetAmount: quote.eur,
        sourceBookUsd: quote.usd,
      },
    ]);
    expect(state.usd).toBe("0.000000");
    expect(state.eur).toBe("8996.851102");
    expect(state.eurBookUsd).toBe("10000.000000");
    expect(state.totalBookUsd).toBe("10000.000000");
    expect(walletCurrentUsd(state, "1.15")).toBe("10346.38");
    expect(walletCurrentUsd(state, "1.20")).toBe("10796.22");
    expect(state.eur).toBe("8996.851102"); // Settings never mutates EUR units
  });

  it("settles a USD supplier at a chosen rate, keeping remaining EUR", () => {
    const converted = {
      kind: "USD_TO_EUR" as const,
      sourceAmount: quote.usd,
      targetAmount: quote.eur,
      sourceBookUsd: quote.usd,
    };
    const before = replayFxAgentWallet("10000", [converted]);
    const payment = settlementPreview("1000", "1.14", before);
    expect(payment.usd).toBe("1140.00");
    expect(payment.bookUsd).toBe("1111.500000");
    expect(payment.gainUsd).toBe("28.500000");
    const after = replayFxAgentWallet("10000", [
      converted,
      { kind: "EUR_SETTLEMENT", sourceAmount: payment.eur, targetAmount: payment.usd, sourceBookUsd: payment.bookUsd },
    ]);
    expect(after.eur).toBe("7996.851102");
    expect(after.eurBookUsd).toBe("8888.500000");
    expect(after.totalBookUsd).toBe("8888.500000");
  });

  it("returns the exact historic USD basis after an unused conversion is reversed", () => {
    const restored = replayFxAgentWallet("10000", [
      { kind: "USD_TO_EUR", sourceAmount: quote.usd, targetAmount: quote.eur, sourceBookUsd: quote.usd },
      { kind: "EUR_TO_USD_REVERSAL", sourceAmount: quote.eur, targetAmount: quote.usd, sourceBookUsd: quote.usd },
    ]);
    expect(restored).toEqual({
      usd: "10000.000000",
      eur: "0.000000",
      eurBookUsd: "0.000000",
      totalBookUsd: "10000.000000",
    });
  });

  it("rejects reversals when the wallet cannot return the recorded EUR or USD basis", () => {
    expect(() =>
      replayFxAgentWallet("1000", [
        { kind: "USD_TO_EUR", sourceAmount: "1000", targetAmount: "900", sourceBookUsd: "1000" },
        { kind: "EUR_TO_USD_REVERSAL", sourceAmount: "901", targetAmount: "1000", sourceBookUsd: "1000" },
      ])
    ).toThrow();
  });

  it("rejects overspending, inconsistent book basis and non-positive rates", () => {
    expect(() => conversionPreview("100", "0")).toThrow();
    expect(() =>
      replayFxAgentWallet("10", [{ kind: "USD_TO_EUR", sourceAmount: "11", targetAmount: "10", sourceBookUsd: "11" }])
    ).toThrow();
    const s = replayFxAgentWallet("100", [
      { kind: "USD_TO_EUR", sourceAmount: "100", targetAmount: "90", sourceBookUsd: "100" },
    ]);
    expect(() => settlementPreview("91", "1.1", s)).toThrow();
    expect(() =>
      replayFxAgentWallet("100", [
        { kind: "USD_TO_EUR", sourceAmount: "100", targetAmount: "90", sourceBookUsd: "100" },
        { kind: "EUR_SETTLEMENT", sourceAmount: "90", targetAmount: "100", sourceBookUsd: "99" },
      ])
    ).toThrow();
  });
});
