import {
  getProformaCapacitySnapshot,
  type ProformaCapacityExecutor,
  type ProformaCapacitySnapshot,
} from "./proformaCapacity";
import { evaluateProformaLoadingAvailability, type ProformaCapacityValidation } from "./proformaCapacityEnforcement";

export type ProformaWriteGuardResult =
  | { allowed: true }
  | {
      allowed: false;
      status: 400 | 404;
      body: {
        message: string;
        capacity?: ReturnType<typeof evaluateProformaLoadingAvailability>;
        capacityIssues?: ProformaCapacityValidation["issues"];
      };
    };

interface ProformaOrderGuardOptions {
  companyId: number;
  proformaId: number;
  customerId: number;
  currentOrderId?: number | null;
}

function unavailableResult(snapshot: ProformaCapacitySnapshot, customerId: number): ProformaWriteGuardResult | null {
  const capacity = evaluateProformaLoadingAvailability(snapshot, customerId, "per_loading");
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
 * Guard linking an already-populated loading to a proforma.
 *
 * Linking is an association/reference action, not a retroactive hard capacity
 * write. Existing scanned bales may already include an intentional overload or
 * an item outside the proforma because the scanner supports explicit soft
 * bypasses for both cases. Refusing the link here traps those already-scanned
 * loadings and prevents the UI from showing the proforma comparison that lets
 * the user review those differences.
 *
 * The link still requires the proforma to exist, be active, and belong to the
 * same customer. Once linked, future scans keep using the normal per-loading
 * membership/overload warnings and bypass rules.
 */
export async function guardExistingOrderProformaLink(
  executor: ProformaCapacityExecutor,
  options: ProformaOrderGuardOptions & { orderId: number }
): Promise<ProformaWriteGuardResult> {
  const { rejection } = await loadGuardedSnapshot(executor, options);
  return rejection ?? { allowed: true };
}
