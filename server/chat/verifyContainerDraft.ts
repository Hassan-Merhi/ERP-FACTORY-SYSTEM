/**
 * Verify-container draft builder for the chat service.
 *
 * Detects "verify container" requests in a chat message, resolves the
 * container number, and assembles the verify-container draft the UI uses to
 * prefill the container verification sheet. Extracted from chatService.ts;
 * behaviour is unchanged (including silent failure when nothing matches).
 */
import { db } from "../db";
import * as schema from "@shared/schema";
import { eq, and, desc, ilike } from "drizzle-orm";

export interface VerifyContainerDraft {
  containerNumber: string;
  containerId: number;
  supplierId: number;
  supplierName: string;
  proformas: { id: number; reference: string | null }[];
}

const VERIFY_CONTAINER_KEYWORDS =
  /\b(verif(y|ication)|container\s+verif|verif.*container|verification\s+excel|excel.*verif|download.*verif|container.*excel)\b/i;

/**
 * Build a verify-container draft when the message asks to verify a container.
 * Returns undefined when the message isn't such a request or the container
 * cannot be resolved — the chat flow treats both the same way (no draft).
 */
export async function buildVerifyContainerDraft(
  userMessage: string,
  companyId: number
): Promise<VerifyContainerDraft | undefined> {
  let verifyContainerDraft: VerifyContainerDraft | undefined = undefined;

  if (!VERIFY_CONTAINER_KEYWORDS.test(userMessage)) return verifyContainerDraft;

  try {
    // Try to extract a container number from the message
    const containerNumMatch =
      userMessage.match(/container\s+(?:no\.?\s*|number\s+|#\s*)?["']?([A-Z0-9][A-Z0-9\-/]{3,25})["']?/i) ||
      userMessage.match(/\b([A-Z]{4}\d{6,7})\b/) ||
      userMessage.match(/\bfor\s+["']?([A-Z0-9][A-Z0-9-]{4,20})["']?\s*(?:$|\s)/i);

    const containerNumber = containerNumMatch ? containerNumMatch[1].toUpperCase() : null;

    if (containerNumber) {
      const [container] = await db
        .select({
          id: schema.containers.id,
          containerNumber: schema.containers.containerNumber,
          supplierId: schema.containers.supplierId,
        })
        .from(schema.containers)
        .where(
          and(eq(schema.containers.companyId, companyId), ilike(schema.containers.containerNumber, containerNumber))
        )
        .limit(1);

      if (container) {
        const [proformas, supplierRow] = await Promise.all([
          db
            .select({ id: schema.supplierProformas.id, reference: schema.supplierProformas.reference })
            .from(schema.supplierProformas)
            .where(
              and(
                eq(schema.supplierProformas.companyId, companyId),
                eq(schema.supplierProformas.supplierId, container.supplierId)
              )
            )
            .orderBy(desc(schema.supplierProformas.createdAt)),
          db
            .select({ name: schema.suppliers.legalName })
            .from(schema.suppliers)
            .where(eq(schema.suppliers.id, container.supplierId))
            .limit(1),
        ]);

        verifyContainerDraft = {
          containerNumber: container.containerNumber,
          containerId: container.id,
          supplierId: container.supplierId,
          supplierName: supplierRow[0]?.name || "",
          proformas,
        };
      }
    }
  } catch (_) {
    // Failed silently — the chat response is still returned.
  }

  return verifyContainerDraft;
}
