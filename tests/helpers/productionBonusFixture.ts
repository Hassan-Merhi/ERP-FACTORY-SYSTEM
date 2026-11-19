/**
 * Production Targets bonus fixture on one (rolled-back) client: a factory
 * company, Production Targets roster workers, closed production days with
 * their saved targets and produced bales, bonus rates and methods, reviews
 * and payment claims. Pair with `withRolledBackPool`, or with the client of
 * `withFactoryWorld` for HTTP tests.
 */
import type { PoolClient } from "pg";

let seq = 0;

export async function createBonusWorld(client: PoolClient, existingCompanyId?: number) {
  const tag = `PB${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase().slice(0, 18);
  const q = async <T = Record<string, any>>(text: string, params: unknown[] = []) =>
    (await client.query(text, params)).rows as T[];
  const one = async (text: string, params: unknown[] = []) => Number((await q<{ id: number }>(text, params))[0]?.id);

  const companyId =
    existingCompanyId ??
    (await one(
      `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
      [tag]
    ));
  const [user] = await q<{ id: string }>(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [
    `${tag.toLowerCase()}_actor`,
  ]);
  const actor = { userId: String(user.id), username: `${tag.toLowerCase()}_actor` };
  const plannerId = await one(
    `INSERT INTO factory_worker_categories (company_id, name, worker_ids) VALUES ($1, 'Pressing', '[]'::jsonb) RETURNING id`,
    [companyId]
  );
  const ledger = (code: string, type: string, currency: string | null = null) =>
    one(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, active, opening_balance_currency)
       VALUES ($1, $2::varchar, $2::text, $3, '0', TRUE, $4) RETURNING id`,
      [companyId, `${tag}${code}`, type, currency]
    );
  const cashId = await ledger("CASH", "Cash");
  const closedDays = new Set<string>();
  const capturedDays = new Set<string>();

  /** A worker on the Production Targets planner roster (unless `rostered` is false). */
  async function worker(name: string, rostered = true) {
    const id = await one(
      `INSERT INTO factory_workers (company_id, full_name, active) VALUES ($1, $2, TRUE) RETURNING id`,
      [companyId, name]
    );
    if (rostered) {
      await q(
        `UPDATE factory_worker_categories SET worker_ids = worker_ids || jsonb_build_array($1::int) WHERE id = $2`,
        [id, plannerId]
      );
    }
    return id;
  }

  async function closeDay(date: string) {
    if (closedDays.has(date)) return;
    closedDays.add(date);
    await q(
      `INSERT INTO factory_staff_tracking_period_closures (company_id, page_type, period_type, period_start, period_end)
       VALUES ($1, 'production', 'daily', $2, $2)`,
      [companyId, date]
    );
  }

  async function bale(workerId: number, date: string, category: string | null) {
    const ref = `${tag}B${++seq}`;
    return one(
      `INSERT INTO factory_bales (company_id, bale_code, reference_number, weight_kg, status, finalized_by, finalized_at,
         stock_entry_date, category, created_at)
       VALUES ($1, $2, $2, 20, 'IN_STOCK', $3, $4::date + interval '10 hours', $4, $5, $4::date + interval '10 hours') RETURNING id`,
      [companyId, ref, workerId, date, category]
    );
  }

  /**
   * One closed production day for a worker: saved target and `produced`
   * finalized bales. With `categories`, the day is category-captured and the
   * bales are frozen in the capture snapshot with those labels.
   */
  async function day(
    date: string,
    workerId: number,
    target: number | null,
    produced: number,
    categories?: Array<string | null>
  ) {
    await closeDay(date);
    await q(
      `INSERT INTO factory_staff_tracking_entries (company_id, page_type, period_type, period_start, period_end,
         person_type, person_id, target_bales, category)
       VALUES ($1, 'production', 'daily', $2, $2, 'worker', $3, $4, 'Pressing')`,
      [companyId, date, workerId, target]
    );
    if (categories && !capturedDays.has(date)) {
      capturedDays.add(date);
      await q(`INSERT INTO factory_target_bonus_category_day_captures (company_id, production_date) VALUES ($1, $2)`, [
        companyId,
        date,
      ]);
    }
    for (let i = 0; i < produced; i++) {
      const category = categories ? (categories[i] ?? null) : null;
      const baleId = await bale(workerId, date, category);
      if (categories) {
        await q(
          `INSERT INTO factory_target_bonus_category_bale_snapshots (company_id, production_date, bale_id, worker_id,
             category_label, source_stock_date)
           VALUES ($1, $2, $3, $4, $5, $2)`,
          [companyId, date, baleId, workerId, category]
        );
      }
    }
  }

  const rate = (scope: "company" | "worker", value: string, workerId: number | null = null, enabled = true) =>
    q(
      `INSERT INTO factory_production_target_bonus_rates (company_id, scope, worker_id, effective_from, enabled,
         rate_per_extra_bale, request_key, created_by)
       VALUES ($1, $2, $3, '2020-01-06', $4, $5, gen_random_uuid()::text, 'fixture')`,
      [companyId, scope, workerId, enabled, value]
    );

  const categoryRate = (label: string, value: string, enabled = true) =>
    q(
      `INSERT INTO factory_production_target_bonus_category_rates (company_id, category_key, category_label,
         effective_from, enabled, rate_per_extra_bale, request_key, created_by)
       VALUES ($1, lower($2), $2, '2020-01-06', $3, $4, gen_random_uuid()::text, 'fixture')`,
      [companyId, label, enabled, value]
    );

  const weeklyMethod = (week: string, method: "weekly_flat" | "per_extra_bale", flat = "0") =>
    one(
      `INSERT INTO factory_production_target_bonus_weekly_methods (company_id, effective_week, method, flat_bonus_usd,
         request_key, created_by)
       VALUES ($1, $2, $3, $4, gen_random_uuid()::text, 'fixture') RETURNING id`,
      [companyId, week, method, flat]
    );

  /** A reviewed worker/day (optionally with a checkout breakdown). */
  async function review(
    date: string,
    workerId: number,
    fields: {
      status?: "approved" | "rejected";
      amount?: string;
      extra?: string;
      produced?: number;
      target?: string;
      rate?: string;
      method?: "standard" | "category";
      breakdown?: unknown[];
    } = {}
  ) {
    const id = await one(
      `INSERT INTO factory_target_bonus_reviews (company_id, production_date, worker_id, target_bales, produced_bales,
         extra_bales, rate_per_bale, bonus_amount, status, reviewed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'fixture') RETURNING id`,
      [
        companyId,
        date,
        workerId,
        fields.target ?? "5",
        fields.produced ?? 7,
        fields.extra ?? "2",
        fields.rate ?? "1",
        fields.amount ?? "2.00",
        fields.status ?? "approved",
      ]
    );
    if (fields.method) {
      await q(
        `INSERT INTO factory_target_bonus_checkout_details (company_id, review_id, method, breakdown, calculation_hash, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, 'fixture')`,
        [companyId, id, fields.method, JSON.stringify(fields.breakdown ?? []), "a".repeat(64)]
      );
    }
    return id;
  }

  /** A posted (or reversed) daily payment claim for a review. */
  async function dailyPayment(reviewId: number, date: string, workerId: number, amount: string, status = "POSTED") {
    const voucher = await one(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, 'Payment', $3, 0) RETURNING id`,
      [companyId, `${tag}V${++seq}`, date]
    );
    const expense = await ledger(`EXP${seq}`, "Expense");
    return one(
      `INSERT INTO factory_target_bonus_payments (company_id, review_id, worker_id, production_date, bonus_amount,
         payment_date, cash_ledger_account_id, expense_ledger_account_id, payment_voucher_id, posted_by, status,
         reversal_voucher_id, reversed_at)
       VALUES ($1, $2, $3, $4, $5, $4, $6, $7, $8, 'fixture', $9, $10, $11) RETURNING id`,
      [
        companyId,
        reviewId,
        workerId,
        date,
        amount,
        cashId,
        expense,
        voucher,
        status,
        status === "REVERSED" ? voucher : null,
        status === "REVERSED" ? new Date() : null,
      ]
    );
  }

  return {
    tag,
    companyId,
    actor,
    cashId,
    q,
    one,
    ledger,
    worker,
    day,
    closeDay,
    rate,
    categoryRate,
    weeklyMethod,
    review,
    dailyPayment,
  };
}

export type BonusWorld = Awaited<ReturnType<typeof createBonusWorld>>;

/** Close the company's books through `through` (fiscal period closure guard). */
export async function closeBooksOn(b: BonusWorld, through: string) {
  const voucherId = await b.one(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
     VALUES ($1, $2, 'Journal', '2000-01-01', 0) RETURNING id`,
    [b.companyId, `${b.tag}CLOSE`]
  );
  const retained = await b.ledger("RE", "Equity");
  await b.q(
    `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
       closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
     VALUES ($1, '2000-01-01', $2, $3, $4, $5, 0, 0, 0, 'CLOSED')`,
    [b.companyId, through, b.actor.userId, voucherId, retained]
  );
}
