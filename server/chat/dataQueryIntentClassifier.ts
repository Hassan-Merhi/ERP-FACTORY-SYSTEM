/**
 * Phase 1 data-query classification for the chat service.
 *
 * Pure, DB-free pieces of the "Phase 1 Data Query Handler": the keyword
 * matcher that decides whether a chat message is a read-only ERP data query
 * (P&L, cash position, statements, …), the relative-date context the
 * classifier prompt embeds, and the classifier prompt itself.
 * Extracted from chatService.ts; behaviour is unchanged.
 */

export const PHASE1_KEYWORDS =
  /profit.{0,15}loss|p&l\b|pl\b.{0,10}report|balance.{0,8}sheet|cash.{0,12}(balance|position|account)|who.{0,20}owe[ds]?|overdue|outstanding.{0,15}(balance|amount|supplier)|customer.{0,15}statement|supplier.{0,15}statement|top.{0,10}(customer|buyer)s?|worker.{0,12}attend|how many.{0,20}(absent|present|worker)|bale.{0,12}(produc|today|week|this|last)|produc.{0,12}bale|how many bale|container.{0,12}status|where.{0,12}(is.{0,5})?container|pending.{0,10}offload|not.{0,10}offload|how much.{0,20}(stock|do we have|in stock)|stock.{0,10}(level|balance|position)|inventory.{0,10}(level|check|status)|low.{0,10}stock|below.{0,10}reorder|reorder.{0,10}level|stock.{0,10}movement|stock.{0,10}histor|movement.{0,10}(for|of).{0,20}\w|open.{0,10}(purchase order|po\b|p\.o\.)|pending.{0,10}(po\b|purchase)|aging|age.{0,10}(report|analysis)|receivable|payable.{0,10}(aging|due)|container.{0,10}list|all container|month.{0,10}(comparison|vs|versus|compare)|last month vs|rental.{0,10}(summary|report|occupan)|occupan|tenant|rent.{0,10}(due|overdue|collect)|payroll.{0,10}(summary|total|report)|total.{0,10}payroll|salary.{0,10}(total|summary)|sales.{0,10}(analys|by item|report|revenue)|how much.{0,15}(did we sell|sold)|top.{0,10}(sell|item|product)|best.{0,10}(sell|item)|container.{0,10}profit|profit.{0,10}per container|how much.{0,15}profit.{0,15}container|stock.{0,10}valuat|inventory.{0,10}value|total.{0,10}inventory.{0,10}(value|worth)|expense.{0,10}(break|categ|by type)|top.{0,10}expense|where.{0,20}money.{0,10}(going|spent)|customer.{0,10}order.{0,10}status|order.{0,10}(pending|draft|verified|finalized|loading)|credit.{0,10}note|recent.{0,10}credit|bank.{0,10}(transaction|movement|histor)|cash.{0,10}(transaction|movement|histor)|recent.{0,10}(payment|receipt|bank)|fixed.{0,10}asset|asset.{0,10}(list|register|summar)|kpi|factory.{0,10}(kpi|performance|daily)|daily.{0,10}(production|output)|efficiency|pos.{0,10}(sale|revenue|summary)|point.{0,10}of.{0,10}sale|shop.{0,10}sale|intercompany|inter.{0,10}company.{0,10}transfer|money.{0,10}(moved|transferred).{0,15}between|offload.{0,10}detail|what.{0,15}(was|were).{0,10}offload|what.{0,10}(arrive|came).{0,15}(in|container)|worker.{0,10}(product|rank|top|best)|top.{0,10}worker|best.{0,10}worker|supplier.{0,10}(spend|history|bought|purchase.{0,10}from)|how much.{0,15}(bought|spend).{0,10}(from|supplier)|upcoming.{0,10}(arrival|container|shipment)|container.{0,10}(arriving|due|expected)|waste.{0,10}(analys|report|trend|summary)|factory.{0,10}waste|customer.{0,10}(payment.{0,10}histor|paid|receipt)|when.{0,10}did.{0,15}pay|voucher.{0,10}(summary|count|by type|breakdown)|how many.{0,10}voucher|stock.{0,10}by.{0,10}location|per.{0,10}location.{0,10}stock|location.{0,10}stock|trial.{0,5}balance|all.{0,10}account.{0,10}balance|balance.{0,10}(of all|per account)|po.{0,10}(detail|line|item)|purchase.{0,10}order.{0,10}(detail|items|break)|what.{0,10}(is|was).{0,10}in.{0,10}(the.{0,5})?po|container.{0,10}(cost|charge|break)|cost.{0,10}break.{0,10}(of|for).{0,10}container|document.{0,10}expir|visa.{0,10}expir|permit.{0,10}expir|worker.{0,10}(doc|expir)|stock.{0,10}transfer|transfer.{0,10}(between|from.{0,10}to).{0,10}(location|warehouse)|move.{0,10}stock|cash.{0,10}flow|money.{0,10}(in|out).{0,10}(this|last|for)|inflow.{0,10}outflow|account.{0,10}(movement|ledger|balance.{0,10}for)|ledger.{0,10}(balance|statement|for)|transaction.{0,10}(of|for).{0,10}account|day.{0,10}(summary|report|sales)|today.{0,10}(sales|voucher)|sale.{0,10}today|profit.{0,10}(by|per).{0,10}location|location.{0,10}profit|which.{0,10}location.{0,10}(most|best)|debit.{0,10}note|supplier.{0,10}debit|customer.{0,10}list|list.{0,10}(of.{0,5})?customer|all.{0,10}customer|supplier.{0,10}list|list.{0,10}(of.{0,5})?supplier|all.{0,10}supplier|stock.{0,10}item.{0,10}(detail|info|profile)|item.{0,10}(detail|info|profile).{0,10}(for|of)|what.{0,10}(is|are).{0,5}(the.{0,5})?details.{0,10}(of|for).{0,10}item|mix.{0,10}batch|batch.{0,10}(list|status|summary)|material.{0,10}batch|customer.{0,10}proforma|price.{0,10}list.{0,10}(for.{0,5})?customer|proforma.{0,10}(for|customer)|supplier.{0,10}proforma|price.{0,10}(list|sheet).{0,10}(from|supplier)|weekly.{0,10}(sale|revenue|breakdown)|sale.{0,10}(by week|per week|week.{0,5}by.{0,5}week)|container.{0,10}(items|content|loaded|what.{0,10}inside)|what.{0,10}(is|are|was).{0,10}(in|inside|loaded).{0,5}container|employee.{0,10}(list|roster|staff)|all.{0,10}(employee|staff)|staff.{0,10}list|journal.{0,10}(entry|entries|voucher)|recent.{0,10}journal|journal.{0,10}posting|audit.{0,10}(log|trail|history)|who.{0,10}(created|deleted|changed|modified|updated)|recent.{0,10}change|bank.{0,10}account.{0,10}(list|balance|all)|all.{0,10}bank|list.{0,10}(of.{0,5})?bank|stock.{0,10}adjust|production.{0,10}(stock|entry|voucher)|consumption.{0,10}(stock|entry)|tracking.{0,10}(event|update|histor)|container.{0,10}tracking|where.{0,10}(is|was).{0,15}container|shipment.{0,10}update|pending.{0,10}(container.{0,10}sale|payment.{0,10}container)|unpaid.{0,10}container|outstanding.{0,10}container|container.{0,10}(unpaid|pending.{0,10}payment)|supplier.{0,10}container|containers.{0,10}(from|by).{0,10}supplier|how many.{0,10}container.{0,10}(from|supplier)|income.{0,10}(break|categ|by type)|revenue.{0,10}(break|by account)|top.{0,10}income.{0,10}account|worker.{0,10}(profile|detail|info)|info.{0,10}(about|for|on).{0,15}worker|who.{0,10}is.{0,10}worker|location.{0,10}(list|all)|all.{0,10}(location|warehouse)|list.{0,10}(of.{0,5})?location|quarterly|quarter.{0,10}(comparison|breakdown|vs)|q[1-4].{0,10}(vs|comparison|revenue)/i;

/** True when the message looks like a read-only ERP data query. */
export function isPhase1DataQuery(userMessage: string): boolean {
  return PHASE1_KEYWORDS.test(userMessage);
}

export interface Phase1DateContext {
  todayStr: string;
  yesterdayStr: string;
  thisMonthStart: string;
  lastMonthStart: string;
  lastMonthEnd: string;
  last30Days: string;
  thisWeekStart: string;
  lastWeekStart: string;
  lastWeekEnd: string;
}

/** Relative-date strings used by the classifier prompt and the query defaults. */
export function buildPhase1DateContext(todayDate: Date): Phase1DateContext {
  const todayStr = todayDate.toISOString().slice(0, 10);
  const yesterdayStr = new Date(todayDate.getTime() - 86400000).toISOString().slice(0, 10);
  const thisMonthStart = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1).toISOString().slice(0, 10);
  const lastMonthStart = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1).toISOString().slice(0, 10);
  const lastMonthEnd = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0).toISOString().slice(0, 10);
  const last30Days = new Date(todayDate.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const dayOfWeek = todayDate.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const thisWeekStart = new Date(todayDate.getTime() + mondayOffset * 86400000).toISOString().slice(0, 10);
  const lastWeekStart = new Date(todayDate.getTime() + (mondayOffset - 7) * 86400000).toISOString().slice(0, 10);
  const lastWeekEnd = new Date(todayDate.getTime() + (mondayOffset - 1) * 86400000).toISOString().slice(0, 10);

  return {
    todayStr,
    yesterdayStr,
    thisMonthStart,
    lastMonthStart,
    lastMonthEnd,
    last30Days,
    thisWeekStart,
    lastWeekStart,
    lastWeekEnd,
  };
}

/** The strict-JSON classifier prompt sent to the AI for Phase 1 queries. */
export function buildPhase1ClassifierPrompt(userMessage: string, dates: Phase1DateContext): string {
  const {
    todayStr,
    yesterdayStr,
    thisMonthStart,
    lastMonthStart,
    lastMonthEnd,
    last30Days,
    thisWeekStart,
    lastWeekStart,
    lastWeekEnd,
  } = dates;

  return `ERP data query classifier. Classify the user's intent and extract parameters. Output ONLY valid JSON, no markdown.
User message: "${userMessage}"
Today: ${todayStr} | Yesterday: ${yesterdayStr}
This week: ${thisWeekStart} to ${todayStr} | Last week: ${lastWeekStart} to ${lastWeekEnd}
This month: ${thisMonthStart} to ${todayStr} | Last month: ${lastMonthStart} to ${lastMonthEnd}
Last 30 days: ${last30Days} to ${todayStr}

Query types:
pl_summary = P&L / profit & loss / income statement for a period
cash_position = current cash and bank account balances
overdue_payments = customers/accounts that owe money (outstanding receivables)
customer_statement = recent transactions for a specific named customer
supplier_statement = recent transactions for a specific named supplier
top_customers = top customers by revenue/receipts for a period
outstanding_suppliers = suppliers with the largest balances owed to them
worker_attendance = worker attendance summary (present/absent) for a date range
bale_production = factory bale production stats for a date range
container_status = status of a specific container by its number
containers_pending_offload = containers that have arrived but not been offloaded yet
inventory_check = stock quantity/levels for a specific item name (or all items if none named)
low_stock_items = items whose current stock is below their reorder level
stock_movement = recent stock adjustments or transfers for a named item
open_purchase_orders = open/pending purchase orders, optionally filtered by supplier name
customer_aging = receivables aging analysis (buckets: 0-30, 31-60, 61-90, 90+ days)
supplier_aging = payables aging analysis (buckets: 0-30, 31-60, 61-90, 90+ days)
container_list = list containers filtered by status (e.g. "In Transit", "Arrived", "Offloaded") or date range
monthly_comparison = compare this month vs last month for revenue / expenses / net profit
rental_summary = rental occupancy, rent due and overdue amounts across all units
payroll_summary = factory payroll totals for a date range
sales_analysis = sales revenue and profit by stock item for a period
top_selling_items = top items ranked by sales quantity or revenue
container_profitability = profit analysis per container (cost vs sale price)
stock_valuation = total inventory value grouped by stock group/category
expense_breakdown = top expense accounts ranked by total spend for a period
customer_order_status = customer orders filtered by status (DRAFT/LOADING/VERIFIED/FINALIZED/CANCELLED)
credit_notes_summary = recent credit notes issued (returns/reversals)
bank_transactions = recent transactions on a specific bank or cash account
fixed_assets_summary = list of fixed assets with purchase amounts and categories
factory_kpi = factory daily KPI snapshots (kg input, kg pressed, bales produced, waste)
pos_sales_summary = POS register sales totals by product or overall for a period
intercompany_transfers = inter-company money transfer history between entities
container_offload_details = detailed breakdown of stock items offloaded from a specific container
worker_productivity = factory worker productivity ranking by bales produced or kg pressed
supplier_spend = total purchase spend per supplier ranked by amount
upcoming_arrivals = containers currently in transit with ETA in the next N days
factory_waste_analysis = factory waste entries analysis by type/date range
customer_payment_history = recent receipts and payments received from customers (named or all)
voucher_type_summary = count and total amounts grouped by voucher type for a period
location_stock_summary = inventory stock totals (items, qty, value) grouped per warehouse location
trial_balance = all ledger accounts with net debit/credit balances for a period
purchase_order_detail = line items and charges for a specific PO number (requires containerNumber or entityName as PO number)
container_cost_breakdown = full cost breakdown (items, freight, surcharge, charges) for a named container
worker_document_expiry = factory workers whose visa, work permit, or residential permit expires within 60 days
stock_transfers = recent stock transfer vouchers showing items moved between locations
cash_flow_summary = total cash/bank inflows vs outflows for a period
ledger_account_balance = all debit/credit transactions for a specific named ledger account
daily_report = all vouchers (every type) posted on a specific date — use dateFrom as the target date
profit_by_location = sales profit grouped by warehouse/location for a period
debit_note_summary = recent debit notes issued (supplier charge-backs or purchase corrections)
customer_list = all customers with their current outstanding balance and contact info
supplier_list = all suppliers with total PO amounts and contact info
stock_item_detail = detailed profile of a named stock item including qty per location
factory_mix_batches = list of factory material mix batches with status and usage
customer_proformas = customer price lists/proformas with item prices and quantities
supplier_proformas = supplier proformas/price sheets with item barcodes and prices
weekly_sales = sales revenue and profit broken down by calendar week for a period
container_items_list = stock items loaded in a specific container (from PO line items)
employee_list = ERP employee roster with salary, balance and department info
journal_entries = recent journal vouchers posted with their account debit/credit entries
audit_trail = recent audit log showing who created, updated, or deleted records
bank_account_list = all registered bank and cash accounts with current balances
stock_adjustments = recent production or consumption stock adjustment vouchers
container_tracking = tracking events and location history for a specific container
pending_container_sales = container sales that are unpaid or partially paid
supplier_container_history = all containers received from a specific named supplier
income_breakdown = top income/revenue accounts ranked by net amount earned
factory_worker_profile = full profile details for a specific named factory worker
location_list = all registered warehouse/location details with stock item counts
quarterly_comparison = revenue, cost, and profit broken down by quarter for the year

Output this JSON shape:
{"queryType":"<one of the above>","entityName":<string or null>,"containerNumber":<string or null>,"locationName":<string or null>,"containerStatus":<string or null>,"dateFrom":<YYYY-MM-DD or null>,"dateTo":"${todayStr}","limit":10}

Field notes:
- entityName: customer/supplier/item/worker name mentioned in the query
- locationName: warehouse or location name mentioned
- containerStatus: one of "In Transit" | "Arrived" | "Offloaded" | null
Date rules: use provided ranges above. Default to last 30 days for financial, today for attendance/production if no date given.
If the intent does not match any type, output: null`;
}
