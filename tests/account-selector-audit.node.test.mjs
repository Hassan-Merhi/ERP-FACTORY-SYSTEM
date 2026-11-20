import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanAccountSelectorSource } from "../scripts/audit-account-selector-new-code.mjs";

describe("Phase 5 account-selector prevention audit", () => {
  it("rejects a newly introduced non-searchable ledger picker", () => {
    const issues = scanAccountSelectorSource(`
      <Select value={ledgerId} onValueChange={setLedgerId}>
        <SelectContent>
          {ledgerAccounts.map((account) => (
            <SelectItem key={account.id} value={String(account.id)}>{account.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>`);
    assert.equal(issues["unsearchable-account-select"], 1);
    assert.equal(issues["visible-account-metadata"], 0);
  });

  it("rejects native bank dropdowns displaying account codes", () => {
    const issues = scanAccountSelectorSource(`
      <select value={bankId}>
        {bankAccounts.map((acc) => (
          <option key={acc.id} value={acc.id}>{acc.code} — {acc.name}</option>
        ))}
      </select>`);
    assert.equal(issues["unsearchable-account-select"], 1);
    assert.equal(issues["visible-account-metadata"], 1);
  });

  it("rejects searchable command rows matching account codes and types", () => {
    const issues = scanAccountSelectorSource(`
      <CommandItem value={`${account.name} ${account.code}`}>
        <span>{account.name}</span> <small>{account.accountType}</small>
      </CommandItem>`);
    assert.equal(issues["visible-account-metadata"], 1);
  });

  it("rejects metadata-derived labels even in the shared picker", () => {
    const issues = scanAccountSelectorSource(`
      <UnifiedAccountPicker
        options={ledgerAccounts.map((account) => ({
          value: String(account.id),
          name: account.code + " - " + account.name,
        }))}
        value={value}
      />`);
    assert.equal(issues["picker-name-uses-metadata"], 1);
  });

  it("permits opaque codes/IDs only as values, not names", () => {
    const issues = scanAccountSelectorSource(`
      <UnifiedAccountPicker
        options={ledgerAccounts.map((account) => ({
          value: "ledger:" + account.id,
          name: account.name,
        }))}
        value={value}
        onChange={setValue}
      />`);
    assert.deepEqual(Object.values(issues), [0, 0, 0]);
  });

  it("ignores non-account selects, account history and display-only audit labels", () => {
    const issues = scanAccountSelectorSource(`
      <Select value={accountType} onValueChange={setAccountType}>
        <SelectContent>
          <SelectItem value="Cash">Cash</SelectItem>
          <SelectItem value="Bank">Bank</SelectItem>
        </SelectContent>
      </Select>
      <div>Historical account: {entry.code} / {entry.name}</div>
      <Select value={role}>
        <SelectContent>
          {roles.map((account) => <SelectItem value={account.id}>{account.name}</SelectItem>)}
        </SelectContent>
      </Select>`);
    assert.deepEqual(Object.values(issues), [0, 0, 0]);
  });

  it("rejects non-searchable generic account lists when their name makes intent clear", () => {
    const issues = scanAccountSelectorSource(`
      <Select value={accountId}>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={String(account.id)}>{account.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>`);
    assert.equal(issues["unsearchable-account-select"], 1);
  });
});
