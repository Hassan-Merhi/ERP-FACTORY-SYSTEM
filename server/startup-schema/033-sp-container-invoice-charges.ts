/**
 * Supplier Partner container invoice charges.
 *
 * The PO Import Excel states freight, surcharge, fumigation and document
 * charges per container. Freight already lived on sp_containers as
 * freight_estimate_usd; the other three gain their own columns so the import
 * can keep them on the container and the offload can add every one of them to
 * landed cost automatically (credited to SP Cost Clearing with the goods cost).
 *
 * Mirrors migrations/20261016_001_sp_container_invoice_charges.sql. Idempotent.
 */
export const spContainerInvoiceCharges: string[] = [
  `ALTER TABLE sp_containers ADD COLUMN IF NOT EXISTS surcharge_usd NUMERIC(20, 4) DEFAULT 0`,
  `ALTER TABLE sp_containers ADD COLUMN IF NOT EXISTS fumigation_usd NUMERIC(20, 4) DEFAULT 0`,
  `ALTER TABLE sp_containers ADD COLUMN IF NOT EXISTS document_charges_usd NUMERIC(20, 4) DEFAULT 0`,
];
