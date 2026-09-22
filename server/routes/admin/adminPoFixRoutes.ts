import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole, requireNonPOS } from "../../auth";

import {
  containers,
  containerOffloads,
  purchaseOrders,
  vouchers,
  voucherEntries,
  suppliers,
  ledgerAccounts,
} from "@shared/schema";
import { eq, and, or, isNull, like } from "drizzle-orm";

export function registerAdminPoFixRoutes(app: Express) {
  app.post("/api/test-data/vouchers", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { date, debitAccountId, creditAccountId, amount, description } = req.body;

      // Validate required fields
      if (!date || !debitAccountId || !creditAccountId || !amount) {
        return res
          .status(400)
          .json({ message: "Missing required fields: date, debitAccountId, creditAccountId, amount" });
      }

      const parsedAmount = parseFloat(amount);
      if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: "Amount must be a positive number" });
      }

      // Verify debit account exists and belongs to current company
      const debitAccount = await storage.getLedgerAccountById(debitAccountId);
      if (!debitAccount || debitAccount.companyId !== companyId) {
        return res.status(404).json({ message: "Debit account not found or doesn't belong to current company" });
      }

      // Verify credit account exists and belongs to current company
      const creditAccount = await storage.getLedgerAccountById(creditAccountId);
      if (!creditAccount || creditAccount.companyId !== companyId) {
        return res.status(404).json({ message: "Credit account not found or doesn't belong to current company" });
      }

      // Generate a unique voucher number with TEST- prefix
      const voucherNumber = `TEST-${Date.now()}`;

      // Create the voucher as optional (excluded from calculations by default)
      const [voucher] = await db
        .insert(vouchers)
        .values({
          companyId,
          voucherNumber,
          voucherType: "Journal",
          voucherDate: date,
          description: description || `Test data entry`,
          totalAmount: parsedAmount.toFixed(2),
          optional: true, // Start as draft/optional
        })
        .returning();

      // Create debit entry
      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: debitAccountId,
        debitAmount: parsedAmount.toFixed(2),
        creditAmount: "0",
        narration: `Test data - ${description || debitAccount.name}`,
      });

      // Create credit entry
      await db.insert(voucherEntries).values({
        voucherId: voucher.id,
        ledgerAccountId: creditAccountId,
        debitAmount: "0",
        creditAmount: parsedAmount.toFixed(2),
        narration: `Test data - ${description || creditAccount.name}`,
      });

      res.status(201).json({
        voucher,
        message: "Test entry created as optional (draft). Toggle to apply to calculations.",
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ==========================================
  // Fix Old PO Inter-Company Credits
  // ==========================================

  app.post("/api/fix-old-po-credits", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const { companyId, parentCompanyId } = req.body;

      if (!companyId) {
        return res.status(400).json({
          message: "Please select a subsidiary company to process.",
        });
      }

      if (!parentCompanyId) {
        return res.status(400).json({
          message: "Please select a parent company.",
        });
      }

      const allCompanies = await storage.getAllCompanies();

      const parentCompany = allCompanies.find((c) => c.id === parentCompanyId);

      if (!parentCompany) {
        return res.status(400).json({
          message: "Selected parent company not found.",
        });
      }

      // Find the selected subsidiary company
      const selectedCompany = allCompanies.find((c) => c.id === companyId);

      if (!selectedCompany) {
        return res.status(400).json({
          message: "Selected subsidiary company not found.",
        });
      }

      if (selectedCompany.id === parentCompany.id) {
        return res.status(400).json({
          message: "Subsidiary and parent company cannot be the same.",
        });
      }

      // Process only the selected subsidiary
      const companiesToProcess = [selectedCompany];

      let totalFixed = 0;
      let totalAmount = 0;
      const details: Array<{ company: string; poNumber: string; amount: number }> = [];

      // Process each company
      for (const company of companiesToProcess) {
        // Get or create "[Parent Company] Credit" account for this subsidiary
        const parentCreditCode = parentCompany.name.toUpperCase().replace(/\s+/g, "_") + "_CREDIT";
        const parentCreditName = parentCompany.name + " Credit";

        let creditAccount = await db
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.companyId, company.id),
              eq(ledgerAccounts.code, parentCreditCode),
              isNull(ledgerAccounts.deletedAt)
            )
          )
          .limit(1);

        if (!creditAccount.length) {
          const [newAccount] = await db
            .insert(ledgerAccounts)
            .values({
              companyId: company.id,
              code: parentCreditCode,
              name: parentCreditName,
              accountType: "Liability",
              subType: "Current Liability",
              openingBalance: "0",
              openingBalanceSide: "Cr",
            })
            .returning();
          creditAccount = [newAccount];
        }

        // Get all purchase orders for this company
        const companyPOs = await db.select().from(purchaseOrders).where(eq(purchaseOrders.companyId, company.id));

        for (const po of companyPOs) {
          // Check if this PO is for an offloaded container
          const [container] = await db.select().from(containers).where(eq(containers.id, po.containerId));

          if (!container || container.status !== "OFFLOADED") {
            continue; // Skip non-offloaded containers
          }

          // Check if credit entry already exists for this PO
          // For OLD fixed POs: fix endpoint uses INTERCO-* in subsidiary and INTERCO-LUB-* in Lubumbashi
          // Check voucher patterns to prevent duplicates
          // NOTE: po.voucherId is for the import voucher (DR Purchases, CR Supplier), NOT inter-company vouchers

          // Check for existing INTERCO vouchers in subsidiary
          // Use both PO number AND container number to identify duplicates (same PO number can apply to multiple containers)
          const existingSubsidiaryVoucher = await db
            .select()
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, company.id),
                like(vouchers.voucherNumber, `INTERCO-%`),
                like(vouchers.description, `%${container.containerNumber}%`)
              )
            )
            .limit(1);

          if (existingSubsidiaryVoucher.length > 0) {
            continue; // Skip - already has credit entry in subsidiary for this container
          }

          // Check for existing INTERCO-PARENT vouchers in parent company for this container
          const existingParentVoucher = await db
            .select()
            .from(vouchers)
            .where(
              and(
                eq(vouchers.companyId, parentCompany.id),
                or(
                  like(vouchers.voucherNumber, `INTERCO-PARENT-%`),
                  like(vouchers.voucherNumber, `INTERCO-LUB-%`), // Legacy format
                  like(vouchers.voucherNumber, `IC-${company.id}-%`)
                ),
                like(vouchers.description, `%${container.containerNumber}%`)
              )
            )
            .limit(1);

          if (existingParentVoucher.length > 0) {
            continue; // Skip - already has credit entry in parent company for this container
          }

          // Calculate PO total: items + freight + charges
          const poItemsTotal = parseFloat(po.itemsTotal || "0");
          const poFreight = parseFloat(po.freight || "0");
          const poSurcharge = parseFloat(po.surcharge || "0");
          const poFumigation = parseFloat(po.fumigation || "0");
          const poDocumentCharges = parseFloat(po.documentCharges || "0");
          const poDiscount = parseFloat(po.discount || "0");
          const poOtherCharges = parseFloat(po.otherCharges || "0");
          const poTotal =
            poItemsTotal + poFreight + poSurcharge + poFumigation + poDocumentCharges - poDiscount + poOtherCharges;

          const poSupplier = po.supplierId
            ? await db.query.suppliers.findFirst({ where: eq(suppliers.id, po.supplierId) })
            : null;
          if (poTotal <= 0) {
            continue; // Skip zero or negative amounts
          }

          // Get offload date from container offload record
          const [offloadRecord] = await db
            .select()
            .from(containerOffloads)
            .where(eq(containerOffloads.containerId, container.id))
            .limit(1);

          const voucherDate = offloadRecord?.offloadedAt
            ? new Date(offloadRecord.offloadedAt).toISOString().split("T")[0]
            : getClientDate(req);

          // ============================================================
          // SUBSIDIARY VOUCHER - Transfer liability from Supplier to Parent Credit
          // ============================================================
          const voucherNumber = `INTERCO-${po.poNumber}-${Date.now()}`;
          const [voucher] = await db
            .insert(vouchers)
            .values({
              companyId: company.id,
              voucherNumber,
              voucherType: "Journal",
              voucherDate,
              description: `Transfer supplier liability to ${parentCompany.name} Credit - PO ${po.poNumber} - Container ${container.containerNumber}`,
              totalAmount: poTotal.toFixed(2),
            })
            .returning();

          // Debit: Supplier account (reduce payable - they got paid by parent company)
          if (po.supplierId) {
            await db.insert(voucherEntries).values({
              voucherId: voucher.id,
              supplierId: po.supplierId,
              debitAmount: poTotal.toFixed(2),
              creditAmount: "0",
              narration: `Transfer to ${parentCompany.name} Credit - PO ${po.poNumber}`,
            });
          }

          // Credit: Parent Credit account (we owe parent company, who paid the supplier)
          await db.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: creditAccount[0].id,
            debitAmount: "0",
            creditAmount: poTotal.toFixed(2),
            narration: `PO ${po.poNumber} - Container ${container.containerNumber} (${parentCompany.name} paid)`,
          });

          // ============================================================
          // PARENT COMPANY VOUCHER - Record receivable from subsidiary + supplier payable
          // ============================================================
          // Get or create "[Subsidiary] Credit" receivable account in parent company
          const subsidiaryCode = company.name.toUpperCase().replace(/\s+/g, "_") + "_CREDIT";
          const subsidiaryName = company.name + " Credit";

          let subsidiaryReceivableAccount = await db
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, parentCompany.id),
                eq(ledgerAccounts.code, subsidiaryCode),
                isNull(ledgerAccounts.deletedAt)
              )
            )
            .limit(1);

          if (!subsidiaryReceivableAccount.length) {
            const [newAccount] = await db
              .insert(ledgerAccounts)
              .values({
                companyId: parentCompany.id,
                code: subsidiaryCode,
                name: subsidiaryName,
                accountType: "Asset",
                subType: "Current Asset",
                openingBalance: "0",
                openingBalanceSide: "Dr",
              })
              .returning();
            subsidiaryReceivableAccount = [newAccount];
          }

          // Create Journal voucher in parent company
          const parentVoucherNumber = `INTERCO-PARENT-${po.poNumber}-${Date.now()}`;
          const [parentVoucher] = await db
            .insert(vouchers)
            .values({
              companyId: parentCompany.id,
              voucherNumber: parentVoucherNumber,
              voucherType: "Journal",
              voucherDate,
              description: `${container.containerNumber} ${poSupplier?.legalName || "Unknown Supplier"}`,
              totalAmount: poTotal.toFixed(2),
            })
            .returning();

          // DR [Subsidiary] Credit (they owe us)
          await db.insert(voucherEntries).values({
            voucherId: parentVoucher.id,
            ledgerAccountId: subsidiaryReceivableAccount[0].id,
            debitAmount: poTotal.toFixed(2),
            creditAmount: "0",
            narration: `PO ${po.poNumber} - ${company.name} owes us`,
          });

          // CR Supplier (we owe supplier)
          if (po.supplierId) {
            await db.insert(voucherEntries).values({
              voucherId: parentVoucher.id,
              supplierId: po.supplierId,
              debitAmount: "0",
              creditAmount: poTotal.toFixed(2),
              narration: `PO ${po.poNumber} - Supplier payment`,
            });
          }

          totalFixed++;
          totalAmount += poTotal;
          details.push({
            company: company.name,
            poNumber: po.poNumber,
            amount: poTotal,
          });
        }
      }

      res.json({
        message: `Fixed ${totalFixed} POs for ${selectedCompany.name} (parent: ${parentCompany.name})`,
        fixed: totalFixed,
        totalAmount: totalAmount.toFixed(2),
        details,
        processedCompanies: 1,
      });
    } catch (error: unknown) {
      logger.error("Fix old PO credits error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ==========================================
  // Fix Parent Company POs Missing Supplier Entries
  // ==========================================

  app.post("/api/fix-parent-po-supplier-entries", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const parentCompanyId = await storage.getParentCompanyId();

      if (!parentCompanyId) {
        return res.status(400).json({
          message: "No parent company configured. Please set the parent company in Settings first.",
        });
      }

      // Get the parent company
      const parentCompany = await storage.getCompanyById(parentCompanyId);
      if (!parentCompany) {
        return res.status(404).json({ message: "Parent company not found" });
      }

      // Find all POs in the parent company
      const allPOs = await db.select().from(purchaseOrders).where(eq(purchaseOrders.companyId, parentCompanyId));

      let fixed = 0;
      let skipped = 0;
      let totalAmount = 0;
      const details = [];

      for (const po of allPOs) {
        if (!po.voucherId || !po.supplierId) {
          skipped++;
          continue;
        }

        // Calculate PO total
        const itemsTotal = parseFloat(po.itemsTotal || "0");
        const freight = parseFloat(po.freight || "0");
        const surcharge = parseFloat(po.surcharge || "0");
        const fumigation = parseFloat(po.fumigation || "0");
        const documentCharges = parseFloat(po.documentCharges || "0");
        const discount = parseFloat(po.discount || "0");
        const otherCharges = parseFloat(po.otherCharges || "0");
        const poTotal = itemsTotal + freight + surcharge + fumigation + documentCharges - discount + otherCharges;

        const _poSupplier = po.supplierId
          ? await db.query.suppliers.findFirst({ where: eq(suppliers.id, po.supplierId) })
          : null;
        if (poTotal <= 0) {
          skipped++;
          continue;
        }

        // Get or create Purchases account
        let purchasesAccount = await storage.getLedgerAccountByName("Purchases", parentCompanyId);
        if (!purchasesAccount) {
          purchasesAccount = await storage.getLedgerAccountByCode("PURCHASES", parentCompanyId);
        }
        if (!purchasesAccount) {
          purchasesAccount = await storage.createLedgerAccount({
            companyId: parentCompanyId,
            name: "Purchases",
            code: "PURCHASES",
            accountType: "Expense",
            subType: "Direct Expense",
          });
        }

        // Check if voucher already has purchase entry
        const existingPurchaseEntry = await db
          .select()
          .from(voucherEntries)
          .where(
            and(eq(voucherEntries.voucherId, po.voucherId), eq(voucherEntries.ledgerAccountId, purchasesAccount.id))
          )
          .limit(1);

        // Check if this voucher already has a supplier entry
        const existingSupplierEntry = await db
          .select()
          .from(voucherEntries)
          .where(and(eq(voucherEntries.voucherId, po.voucherId), eq(voucherEntries.supplierId, po.supplierId)))
          .limit(1);

        // Skip if both entries already exist
        if (existingPurchaseEntry.length > 0 && existingSupplierEntry.length > 0) {
          skipped++;
          continue;
        }

        let fixedThisPO = false;

        // Add DR Purchases entry if missing
        if (existingPurchaseEntry.length === 0) {
          await db.insert(voucherEntries).values({
            voucherId: po.voucherId,
            ledgerAccountId: purchasesAccount.id,
            debitAmount: poTotal.toFixed(2),
            creditAmount: "0",
            narration: `PO ${po.poNumber} - Fix missing entry`,
          });
          fixedThisPO = true;
        }

        // Add CR Supplier entry if missing
        if (existingSupplierEntry.length === 0) {
          await db.insert(voucherEntries).values({
            voucherId: po.voucherId,
            supplierId: po.supplierId,
            debitAmount: "0",
            creditAmount: poTotal.toFixed(2),
            narration: `PO ${po.poNumber} - Fix missing supplier entry`,
          });
          fixedThisPO = true;
        }

        if (fixedThisPO) {
          fixed++;
          totalAmount += poTotal;
          details.push({
            poNumber: po.poNumber,
            amount: poTotal.toFixed(2),
            fixedPurchases: existingPurchaseEntry.length === 0,
            fixedSupplier: existingSupplierEntry.length === 0,
          });
        } else {
          skipped++;
        }
      }

      res.json({
        message: `Fixed ${fixed} POs in ${parentCompany.name}. Skipped ${skipped} (already had entries or invalid).`,
        fixed,
        skipped,
        totalAmount: totalAmount.toFixed(2),
        details,
      });
    } catch (error: unknown) {
      logger.error("Fix parent PO supplier entries error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ==========================================
  // Reverse Fix Old PO Inter-Company Credits
  // ==========================================

  app.post("/api/reverse-po-credits", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const { companyId, parentCompanyId } = req.body;

      if (!companyId) {
        return res.status(400).json({
          message: "Please select a subsidiary company to reverse.",
        });
      }

      if (!parentCompanyId) {
        return res.status(400).json({
          message: "Please select a parent company.",
        });
      }

      const allCompanies = await storage.getAllCompanies();
      const company = allCompanies.find((c) => c.id === companyId);
      const parentCompany = allCompanies.find((c) => c.id === parentCompanyId);

      if (!company) {
        return res.status(400).json({ message: "Subsidiary company not found." });
      }

      if (!parentCompany) {
        return res.status(400).json({
          message: "Parent company not found.",
        });
      }

      if (company.id === parentCompany.id) {
        return res.status(400).json({
          message: "Subsidiary and parent company cannot be the same.",
        });
      }

      // Process only the selected subsidiary
      const targetCompany = company;

      let totalReversed = 0;
      const details: Array<{ company: string; voucherNumber: string; amount: string }> = [];

      // Delete INTERCO vouchers in this subsidiary company
      const companyIntercoVouchers = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.companyId, targetCompany.id), like(vouchers.voucherNumber, "INTERCO-%")));

      for (const v of companyIntercoVouchers) {
        // Delete voucher entries first
        await db.delete(voucherEntries).where(eq(voucherEntries.voucherId, v.id));
        // Delete voucher
        await db.delete(vouchers).where(eq(vouchers.id, v.id));
        totalReversed++;
        details.push({ company: targetCompany.name, voucherNumber: v.voucherNumber, amount: v.totalAmount || "0" });
      }

      // Also delete corresponding INTERCO-PARENT vouchers in parent company for this subsidiary
      const parentIntercoVouchers = await db
        .select()
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, parentCompany.id),
            or(
              like(vouchers.voucherNumber, "INTERCO-PARENT-%"),
              like(vouchers.voucherNumber, "INTERCO-LUB-%") // Also match old format
            ),
            like(vouchers.description, `%${targetCompany.name}%`)
          )
        );

      for (const v of parentIntercoVouchers) {
        await db.delete(voucherEntries).where(eq(voucherEntries.voucherId, v.id));
        await db.delete(vouchers).where(eq(vouchers.id, v.id));
        totalReversed++;
        details.push({
          company: `${parentCompany.name} (for ${targetCompany.name})`,
          voucherNumber: v.voucherNumber,
          amount: v.totalAmount || "0",
        });
      }

      res.json({
        message: `Reversed ${totalReversed} inter-company vouchers for ${company.name} (parent: ${parentCompany.name})`,
        reversed: totalReversed,
        details,
        processedCompanies: 1,
      });
    } catch (error: unknown) {
      logger.error("Reverse PO credits error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ==========================================
  // Reset Company Data (Admin only)
  // Deletes Payment/Receipt/Journal vouchers for selected company
  // ==========================================
}
