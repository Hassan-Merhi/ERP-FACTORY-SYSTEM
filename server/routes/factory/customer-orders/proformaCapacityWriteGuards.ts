import { sql } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import {
  getProformaCapacitySnapshot,
  type ProformaCapacityExecutor,
  type ProformaCapacitySnapshot,
} from "./proformaCapacity";
import { evaluateProformaLoadingAvailability, validateProformaCapacityAdditions } from "./proformaCapacityEnforcement";

export type ProformaWriteGuardResult =
  | { allowed: true }
  | {
      allowed: false;
      status: 400 | 404;
      body: {
        message: string;
        capacity?: ReturnType<typeof evaluateProformaLoadingAvailability>;
        capacityIssues?: ReturnType<typeof validateProformaCapacityAdditions>["issues"];
      };
    };

interface ProformaOrderGuardOptions {
  companyId: number;
  proformaId: number;
  customerId: number;
  currentOrderId?: number | null;
}

function unavailableResult(snapshot: ProformaCapacitySnapshot, customerId: number): ProformaWriteGuardResult | null {
  const capacity = evaluateProformaLoadingAvailability(snapshot, customerId);
  if (capacity.allowed) return null;

  const message =
    capacity.reason === "customer_mismatch"
      ? "Customer does not match the selected proforma"
      : capacity.reason === "fully_consumed"
        ? "Proforma has no remaining loading capacity"
        : "Proforma is inactive";

  return { allowed: false, status: 400, body: { message, capacity } };
}

async function loadGuardedSnapshot(
  executor: ProformaCapacityExecutor,
  options: ProformaOrderGuardOptions
): Promise<{ snapshot: ProformaCapacitySnapshot | null; rejection: ProformaWriteGuardResult | null }> {
  const snapshot = await getProformaCapacitySnapshot(executor, {
    companyId: options.companyId,
    proformaId: options.proformaId,
    currentOrderId: options.currentOrderId,
  });
  if (!snapshot) {
    return {
      snapshot: null,
      rejection: { allowed: false, status: 404, body: { message: "Proforma not found" } },
    };
  }

  return { snapshot, rejection: unavailableResult(snapshot, options.customerId) };
}

/** Guard creation of an empty loading/order linked to an existing proforma. */
export async function guardProformaOrderCreation(
  executor: ProformaCapacityExecutor,
  options: ProformaOrderGuardOptions
): Promise<ProformaWriteGuardResult> {
  const { rejection } = await loadGuardedSnapshot(executor, options);
  return rejection ?? { allowed: true };
}

/**
 * Guard linking an already-populated loading to a proforma. Existing loaded
 * bales must all be on the target proforma and fit inside its remaining global
 * capacity before the association can be written.
 */
export async function guardExistingOrderProformaLink(
  executor: ProformaCapacityExecutor,
  options: ProformaOrderGuardOptions & { orderId: number }
): Promise<ProformaWriteGuardResult> {
  const { snapshot, rejection } = await loadGuardedSnapshot(executor, options);
  if (rejection) return rejection;
  if (!snapshot) {
    return { allowed: false, status: 404, body: { message: "Proforma not found" } };
  }

  const loadedArticleRows = resultRows<{ articleCode: string | null; quantity: number }>(
    await executor.execute(sql`
      SELECT
        COALESCE(
          NULLIF(TRIM(cob.article_code), ''),
          NULLIF(TRIM(fb.article_code), ''),
          NULLIF(TRIM(fbp.article_code), ''),
          ''
        ) AS "articleCode",
        COUNT(DISTINCT cob.bale_id)::int AS quantity
      FROM customer_order_bales cob
      LEFT JOIN factory_bales fb ON fb.id = cob.bale_id
      LEFT JOIN factory_bale_products fbp
        ON fbp.id = fb.product_id
       AND fbp.company_id = ${options.companyId}
      WHERE cob.order_id = ${options.orderId}
      GROUP BY COALESCE(
        NULLIF(TRIM(cob.article_code), ''),
        NULLIF(TRIM(fb.article_code), ''),
        NULLIF(TRIM(fbp.article_code), ''),
        ''
      )
    `)
  ).filter((row) => !!row.articleCode && Number(row.quantity) > 0);

  const validation = validateProformaCapacityAdditions(snapshot, loadedArticleRows);
  if (!validation.allowed) {
    return {
      allowed: false,
      status: 400,
      body: {
        message: "Existing loaded bales exceed or do not match the selected proforma capacity",
        capacityIssues: validation.issues,
      },
    };
  }

  return { allowed: true };
}
