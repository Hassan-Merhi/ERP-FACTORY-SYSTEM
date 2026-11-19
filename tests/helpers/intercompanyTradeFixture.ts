/**
 * A complete, pristine Properties -> ERP linked container trade seeded with
 * plain SQL on one (rolled-back) client: both companies, the seven mapped
 * ledgers, the partner supplier, the physical container, the original
 * supplier PO and the mirrored destination PO with linked lines, the import
 * batch and the `container-import-confirmed` audit evidence. Pair with
 * `withRolledBackPool` so the services under test see the same transaction.
 */
import type { PoolClient } from "pg";

import type { EditIdentity } from "../../server/services/intercompany/tradeSync";

let seq = 0;

export async function createIntercompanyTradeWorld(client: PoolClient, options: { landed?: string } = {}) {
  const tag = `IC${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase().slice(0, 16);
  const landed = options.landed ?? "100.00";
  const q = async <T = Record<string, any>>(text: string, params: unknown[] = []) =>
    (await client.query(text, params)).rows as T[];
  const one = async (text: string, params: unknown[] = []) => Number((await q<{ id: number }>(text, params))[0]?.id);

  const company = (suffix: string, type: string, currency = "USD") =>
    one(
      `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $2, $3, $4) RETURNING id`,
      [`${tag}${suffix}`, `${tag} ${suffix} Holdings`, type, currency]
    );
  const sourceCompanyId = await company("P", "properties");
  const destinationCompanyId = await company("E", "erp");
  const [source] = await q<{ name: string }>(`SELECT name FROM companies WHERE id = $1`, [sourceCompanyId]);

  const [user] = await q<{ id: string }>(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [
    `${tag.toLowerCase()}_owner`,
  ]);
  const userId = String(user.id);
  const member = (companyId: number, role: string, who = userId) =>
    q(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, $3)`, [who, companyId, role]);
  await member(sourceCompanyId, "Owner");
  await member(destinationCompanyId, "Owner");

  const ledger = (companyId: number, code: string, type: string) =>
    one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active)
       VALUES ($1, $2::varchar, $2::text, $3, '0', TRUE) RETURNING id`,
      [companyId, `${code}-${tag}`, type]
    );
  const accounts = {
    sourceReceivableAccountId: await ledger(sourceCompanyId, "AR", "Asset"),
    destinationPayableAccountId: await ledger(destinationCompanyId, "AP", "Liability"),
    sourceSalesAccountId: await ledger(sourceCompanyId, "SALES", "Income"),
    sourcePurchaseAccountId: await ledger(sourceCompanyId, "PURCH", "Expense"),
    sourceCostAccountId: await ledger(sourceCompanyId, "COGS", "Expense"),
    sourceChargeAccrualAccountId: await ledger(sourceCompanyId, "CHARGE", "Liability"),
    destinationGitAccountId: await ledger(destinationCompanyId, "GIT", "Asset"),
  };
  const supplier = (companyId: number, code: string, name: string) =>
    one(
      `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, $3, '', TRUE) RETURNING id`,
      [companyId, `${code}-${tag}`, name]
    );
  const externalSupplierId = await supplier(sourceCompanyId, "EXT", "External Mill");
  const partnerSupplierId = await supplier(destinationCompanyId, "PARTNER", source.name);
  const stockItemId = await one(
    `INSERT INTO stock_items (company_id, code, name, uom) VALUES ($1, $2, 'Bales', 'kg') RETURNING id`,
    [destinationCompanyId, `SI-${tag}`]
  );

  const relationshipId = await one(
    `INSERT INTO intercompany_relationship_policies (source_company_id, destination_company_id, relationship_type,
       trade_enabled, base_currency, destination_supplier_id, source_receivable_account_id, destination_payable_account_id,
       source_sales_account_id, source_purchase_account_id, source_cost_account_id, source_charge_accrual_account_id,
       destination_git_account_id)
     VALUES ($1, $2, 'container_trade', TRUE, 'USD', $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      sourceCompanyId,
      destinationCompanyId,
      partnerSupplierId,
      accounts.sourceReceivableAccountId,
      accounts.destinationPayableAccountId,
      accounts.sourceSalesAccountId,
      accounts.sourcePurchaseAccountId,
      accounts.sourceCostAccountId,
      accounts.sourceChargeAccrualAccountId,
      accounts.destinationGitAccountId,
    ]
  );

  const voucher = (companyId: number, kind: string, type: string) =>
    one(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, $3, '2026-06-01', $4) RETURNING id`,
      [companyId, `${tag}-${kind}`, type, landed]
    );

  /**
   * One linked trade on its own physical container (several per world are allowed).
   * `chargeEvidence` records the import's charge evidence reference, as an import
   * with confirmed PO charges does.
   */
  async function trade(
    suffix = "A",
    status = "OTW",
    destinationLineRate = landed,
    chargeEvidence: string | null = null
  ) {
    const containerId = await one(
      `INSERT INTO containers (company_id, container_number, import_date, supplier_id, status, items_total,
         charges_total, grand_total)
       VALUES ($1, $2, '2026-06-01', $3, $5, $4, 0, $4) RETURNING id`,
      [sourceCompanyId, `${tag}${suffix}`, externalSupplierId, landed, status]
    );
    const vouchers = {
      sourcePurchase: await voucher(sourceCompanyId, `SP${suffix}`, "Purchase"),
      destinationPurchase: await voucher(destinationCompanyId, `DP${suffix}`, "Purchase"),
      sale: await voucher(sourceCompanyId, `SL${suffix}`, "Sales"),
      cost: await voucher(sourceCompanyId, `CO${suffix}`, "Journal"),
    };
    const po = (companyId: number, supplierId: number, voucherId: number, number: string) =>
      one(
        `INSERT INTO purchase_orders (company_id, container_id, supplier_id, voucher_id, po_number, items_total, freight,
           surcharge, fumigation, document_charges, discount, other_charges, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, 0, 0, 'USD', 'Open') RETURNING id`,
        [companyId, containerId, supplierId, voucherId, `${tag}${number}`, landed]
      );
    const sourcePoId = await po(sourceCompanyId, externalSupplierId, vouchers.sourcePurchase, `S${suffix}`);
    const destinationPoId = await po(
      destinationCompanyId,
      partnerSupplierId,
      vouchers.destinationPurchase,
      `D${suffix}`
    );
    const line = (poId: number, rate: string) =>
      one(
        `INSERT INTO po_line_items (po_id, stock_item_id, item_name, quantity, rate, line_total)
         VALUES ($1, $2, 'Bales', 1, $3, $3) RETURNING id`,
        [poId, stockItemId, rate]
      );
    const sourceLineId = await line(sourcePoId, landed);
    const destinationLineId = await line(destinationPoId, destinationLineRate);
    const tradeId = await one(
      `INSERT INTO intercompany_trades (relationship_id, physical_container_id, source_company_id, destination_company_id,
         original_supplier_po_id, destination_po_id, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING id`,
      [relationshipId, containerId, sourceCompanyId, destinationCompanyId, sourcePoId, destinationPoId]
    );
    await q(
      `INSERT INTO intercompany_trade_source_pos (trade_id, source_po_id, original_po_number) VALUES ($1, $2, $3)`,
      [tradeId, sourcePoId, `${tag}S${suffix}`]
    );
    const lineLinkId = await one(
      `INSERT INTO intercompany_trade_line_links (trade_id, source_line_id, destination_line_id, original_excel_row)
       VALUES ($1, $2, $3, 1) RETURNING id`,
      [tradeId, sourceLineId, destinationLineId]
    );
    const batchId = await one(
      `INSERT INTO intercompany_import_batches (source_company_id, file_name, file_sha256, request_fingerprint, state, created_by)
       VALUES ($1, 'fixture.xlsx', md5($2) || md5($2), md5($2 || 'f') || md5($2 || 'f'), 'confirmed', $3) RETURNING id`,
      [sourceCompanyId, `${tag}${suffix}`, userId]
    );
    await q(
      `INSERT INTO intercompany_import_batch_containers (batch_id, container_number, destination_company_id,
         physical_container_id, trade_id, confirmed_landed_cost, charge_evidence_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [batchId, `${tag}${suffix}`, destinationCompanyId, containerId, tradeId, landed, chargeEvidence]
    );
    const payload = {
      physicalContainerId: containerId,
      originalSupplierVoucherIds: [vouchers.sourcePurchase],
      sourceSaleVoucherId: vouchers.sale,
      sourceCostVoucherId: vouchers.cost,
      destinationVoucherId: vouchers.destinationPurchase,
    };
    return {
      tradeId,
      containerId,
      sourcePoId,
      destinationPoId,
      sourceLineId,
      destinationLineId,
      lineLinkId,
      batchId,
      vouchers,
      /** Record the import audit evidence (optionally overridden) for this trade. */
      audit: (override: Record<string, unknown> = {}, key = `ic-container-import:${batchId}:${tradeId}`) =>
        q(
          `INSERT INTO intercompany_audit_events (event_key, relationship_id, source_company_id, event_type, payload)
           VALUES ($1, $2, $3, 'container-import-confirmed', $4::jsonb)`,
          [key, relationshipId, sourceCompanyId, JSON.stringify({ ...payload, ...override })]
        ),
    };
  }

  const identity = (companyId = sourceCompanyId, role = "Owner", who = userId): EditIdentity => ({
    initiatingCompanyId: companyId,
    actorUserId: who,
    actorRole: role,
  });

  /** Another user with the given roles per company. */
  async function otherUser(roles: Array<[number, string]>) {
    const [row] = await q<{ id: string }>(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [
      `${tag.toLowerCase()}_u${++seq}`,
    ]);
    for (const [companyId, role] of roles) await member(companyId, role, String(row.id));
    return String(row.id);
  }

  return {
    tag,
    q,
    one,
    sourceCompanyId,
    destinationCompanyId,
    sourceName: source.name,
    userId,
    accounts,
    externalSupplierId,
    partnerSupplierId,
    stockItemId,
    relationshipId,
    ledger,
    supplier,
    company,
    trade,
    identity,
    otherUser,
  };
}

export type IntercompanyTradeWorld = Awaited<ReturnType<typeof createIntercompanyTradeWorld>>;
