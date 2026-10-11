/**
 * The intercompany accounts of a subsidiary's PO import (split out of
 * po-import.ts, unchanged behaviour):
 *
 *   - the parent's receivable from the subsidiary (due-from; phase 26, MC-9):
 *     the account recorded in the subsidiary's settings
 *     (parent_receivable_account_id) first; else "[Subsidiary Name] Credit" in
 *     the parent (Asset), found or created, and its id recorded so group
 *     elimination pairs it by id, not by name;
 *   - the subsidiary's credit to the parent (due-to): "[Parent Name] Credit"
 *     (Liability) found or created in the subsidiary and recorded as its
 *     parent_credit_account_id.
 *
 * Every lookup names its company, so a same-named account in another tenant is
 * never used.
 */
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { storage } from "../../storage";

export async function resolveSubsidiaryReceivableAccount(input: {
  currentCompanyId: number;
  linkedParentCompanyId: number;
  subsidiaryName: string;
}) {
  const { currentCompanyId, linkedParentCompanyId, subsidiaryName } = input;
  const subsidiaryAccountName = `${subsidiaryName} Credit`;
  const subsidiarySettings = await storage.getCompanySettings(currentCompanyId);
  const configuredReceivableId = Number(subsidiarySettings?.parentReceivableAccountId) || null;
  const configuredReceivable = configuredReceivableId
    ? await storage.getLedgerAccountById(configuredReceivableId)
    : undefined;
  let subsidiaryReceivableAccount =
    configuredReceivable && configuredReceivable.companyId === linkedParentCompanyId && !configuredReceivable.deletedAt
      ? configuredReceivable
      : await storage.getLedgerAccountByName(subsidiaryAccountName, linkedParentCompanyId);
  if (!subsidiaryReceivableAccount) {
    const parentAccountPrefix = subsidiaryName.substring(0, 3).toUpperCase() + "CRD";
    let code = parentAccountPrefix;
    let suffix = 1;
    while (await storage.getLedgerAccountByCode(code, linkedParentCompanyId)) {
      code = parentAccountPrefix + suffix;
      suffix++;
    }
    subsidiaryReceivableAccount = await storage.createLedgerAccount({
      companyId: linkedParentCompanyId,
      name: subsidiaryAccountName,
      code,
      accountType: "Asset",
      subType: "Current Asset",
    });
  }
  if (configuredReceivableId !== subsidiaryReceivableAccount.id) {
    await storage.upsertCompanySettings({
      companyId: currentCompanyId,
      parentReceivableAccountId: subsidiaryReceivableAccount.id,
    });
  }
  return subsidiaryReceivableAccount;
}

/** The subsidiary's "[Parent Name] Credit" account id (found or created, retried for concurrent requests). */
export async function ensureParentCreditAccount(input: {
  currentCompanyId: number;
  parentCompanyId: number;
}): Promise<number | null> {
  const { currentCompanyId, parentCompanyId } = input;
  let parentCreditAccountId: number | null = null;
  const parentCompany = await storage.getCompanyById(parentCompanyId);
  const parentName = parentCompany?.name || "Parent Company";
  const creditAccountName = `${parentName} Credit`;

  // Try to find or create the account (with retry for concurrent requests)
  for (let attempt = 0; attempt < 3 && !parentCreditAccountId; attempt++) {
    try {
      // Always fetch first - handles concurrent creation
      let existingAccount = await storage.getLedgerAccountByName(creditAccountName, currentCompanyId);

      if (!existingAccount && attempt < 2) {
        // Auto-generate unique code
        let code = parentName.substring(0, 3).toUpperCase() + "CRD";
        let suffix = 1;
        while (await storage.getLedgerAccountByCode(code, currentCompanyId)) {
          code = parentName.substring(0, 3).toUpperCase() + "CRD" + suffix;
          suffix++;
        }
        existingAccount = await storage.createLedgerAccount({
          companyId: currentCompanyId,
          name: creditAccountName,
          code,
          accountType: "Liability",
          subType: "Current Liability",
        });
      }

      if (existingAccount?.id) {
        parentCreditAccountId = existingAccount.id;

        // Save to company settings for future use
        await storage.upsertCompanySettings({
          companyId: currentCompanyId,
          parentCreditAccountId: parentCreditAccountId,
        });
        logger.info(`Auto-created Parent Credit Account: ${creditAccountName} (ID: ${parentCreditAccountId})`);
      }
    } catch (err: unknown) {
      logger.info(`Parent Credit Account creation attempt ${attempt + 1} failed, will retry fetch:`, {
        error: getErrorMessage(err),
      });
      // On any error, loop will retry with fetch-first approach
    }
  }
  return parentCreditAccountId;
}
