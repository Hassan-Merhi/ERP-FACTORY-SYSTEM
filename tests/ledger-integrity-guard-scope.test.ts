/**
 * The ledger integrity guards are defined by the schema migrations (migrations/),
 * not installed at runtime. Two of their SQL functions mirror the TypeScript
 * account classifier: erp_ledger_account_class (the class of an account) and
 * erp_default_ledger_opening_side (the side of a sideless opening). This pins
 * the migrated definitions to accountClassification's type lists, so a change
 * to the classifier without a schema migration fails here.
 */
import { describe, expect, it } from "vitest";

import { accountTypeNamesOf } from "../server/services/accounting/accountClassification";
import {
  LEDGER_ACCOUNT_PARENT_FK,
  LEDGER_ACCOUNT_TREE_TRIGGER,
  LEDGER_GUARD_CONSTRAINTS,
} from "../server/services/accounting/ledgerIntegrityGuard";
import { functionDefinition, hasTrigger, manifestEntry } from "./helpers/schemaManifest";

const typeList = (...classes: Parameters<typeof accountTypeNamesOf>) =>
  accountTypeNamesOf(...classes)
    .map((name) => `'${name}'`)
    .join(", ");

const ACCOUNT_CLASSES = ["asset", "liability", "equity", "income", "expense", "party"] as const;

describe("ledger integrity guard schema", () => {
  it("classifies accounts in SQL exactly as accountClassification does", () => {
    const definition = functionDefinition("erp_ledger_account_class");
    expect(definition).toBeDefined();
    for (const column of ["p_type", "p_sub_type"]) {
      for (const accountClass of ACCOUNT_CLASSES) {
        expect(definition).toContain(
          `WHEN lower(btrim(COALESCE(${column}, ''))) IN (${typeList(accountClass)}) THEN '${accountClass}'`
        );
      }
    }
    expect(definition).toContain("ELSE 'unknown'");
  });

  it("puts a sideless opening on the classifier's side", () => {
    const definition = functionDefinition("erp_default_ledger_opening_side");
    expect(definition).toBeDefined();
    expect(definition).toContain(`WHEN t IN (${typeList("asset", "expense")}) THEN 'Dr'`);
    expect(definition).toContain(`WHEN t IN (${typeList("liability", "equity", "income")}) THEN 'Cr'`);
    expect(definition).toContain("WHEN t = 'customer' THEN 'Dr'");
    expect(definition).toContain(`WHEN t IN (${typeList("party")}) THEN 'Cr'`);
  });

  it("defines the constraints and triggers the integrity diagnostic requires", () => {
    for (const name of LEDGER_GUARD_CONSTRAINTS) {
      expect(manifestEntry("constraint", `public.voucher_entries.${name}`), name).toBeDefined();
    }
    expect(manifestEntry("constraint", `public.ledger_accounts.${LEDGER_ACCOUNT_PARENT_FK}`)).toBeDefined();
    expect(hasTrigger("voucher_entries", "voucher_entries_target_guard")).toBe(true);
    expect(hasTrigger("ledger_accounts", "ledger_accounts_delete_guard")).toBe(true);
    expect(hasTrigger("bank_accounts", "bank_accounts_delete_guard")).toBe(true);
    expect(hasTrigger("ledger_accounts", LEDGER_ACCOUNT_TREE_TRIGGER)).toBe(true);
  });
});
