import { storage } from "../../storage";
import { logger } from "../../lib/logger";

// ─── Exchange rate ────────────────────────────────────────────────────────────
/**
 * The company's display rate (base → display currency) recorded on or before
 * `asOf` (default: the company's business date), through the phase 24 resolver.
 * Voucher writers pass the voucher date (phase 24, M4): a back-dated voucher
 * used to take today's rate.
 */
export async function getCurrentExchangeRate(companyId: number, asOf?: string): Promise<string | null> {
  try {
    const company = await storage.getCompanyById(companyId);
    if (!company || !company.displayCurrency || !company.baseCurrency) {
      return null;
    }
    const rate = await storage.getLatestExchangeRate(companyId, company.baseCurrency, company.displayCurrency, asOf);
    return rate?.rate || null;
  } catch (error) {
    logger.error("Error fetching exchange rate:", { error: error });
    return null;
  }
}
