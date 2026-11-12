import { PROPERTIES_PO_IMPORT_ERRORS } from "@/i18n/propertiesPoImportTranslations";

/**
 * Pure selection rules for the normal PO Import wizard when Properties is
 * purchasing containers on behalf of ERP companies.
 *
 * An override remains an override when the default changes. A blank default
 * never silently sends a container to an arbitrary company.
 */
export interface PropertiesContainerDestination {
  destinationCompanyId: string;
  overridden: boolean;
  chargesConfirmed: boolean;
  chargeEvidenceReference: string;
}
export type PropertiesContainerDestinations = Record<string, PropertiesContainerDestination>;

export function initializePropertiesDestinations(
  containerNumbers: readonly string[],
  defaultCompanyId: string
): PropertiesContainerDestinations {
  return Object.fromEntries(
    containerNumbers.map((containerNumber) => [
      containerNumber,
      {
        destinationCompanyId: defaultCompanyId,
        overridden: false,
        chargesConfirmed: false,
        chargeEvidenceReference: "",
      },
    ])
  );
}

export function updatePropertiesDefaultDestination(
  current: PropertiesContainerDestinations,
  newDefaultCompanyId: string
): PropertiesContainerDestinations {
  return Object.fromEntries(
    Object.entries(current).map(([containerNumber, selection]) => [
      containerNumber,
      selection.overridden
        ? selection
        : { ...selection, destinationCompanyId: newDefaultCompanyId },
    ])
  );
}

export function updatePropertiesContainerDestination(
  current: PropertiesContainerDestinations,
  containerNumber: string,
  nextCompanyId: string | null,
  defaultCompanyId: string
): PropertiesContainerDestinations {
  const original = current[containerNumber];
  if (!original) throw new Error(PROPERTIES_PO_IMPORT_ERRORS.unknownContainer);
  return {
    ...current,
    [containerNumber]: {
      ...original,
      destinationCompanyId: nextCompanyId === null ? defaultCompanyId : nextCompanyId,
      overridden: nextCompanyId !== null,
    },
  };
}

export function updatePropertiesContainerCharges(
  current: PropertiesContainerDestinations,
  containerNumber: string,
  change: Partial<Pick<PropertiesContainerDestination, "chargesConfirmed" | "chargeEvidenceReference">>
): PropertiesContainerDestinations {
  const original = current[containerNumber];
  if (!original) throw new Error(PROPERTIES_PO_IMPORT_ERRORS.unknownContainer);
  return { ...current, [containerNumber]: { ...original, ...change } };
}

export interface PropertiesContainerPreviewLine {
  containerNumber: string;
  chargesTotal: number;
}

export function validatePropertiesImportSelections(
  containers: readonly PropertiesContainerPreviewLine[],
  destinations: PropertiesContainerDestinations,
  permittedCompanyIds: ReadonlySet<number>
): Array<{
  containerNumber: string;
  destinationCompanyId: number;
  chargesConfirmed: boolean;
  chargeEvidenceReference?: string;
}> {
  if (containers.length === 0 || Object.keys(destinations).length !== containers.length) {
    throw new Error(PROPERTIES_PO_IMPORT_ERRORS.missingSelections);
  }
  const unique = new Set<string>();
  return containers.map((container) => {
    const normalized = container.containerNumber.trim().toUpperCase();
    if (!normalized || unique.has(normalized)) throw new Error(PROPERTIES_PO_IMPORT_ERRORS.duplicateContainer);
    unique.add(normalized);
    const selected = destinations[container.containerNumber];
    const destinationCompanyId = Number(selected?.destinationCompanyId);
    if (!selected || !Number.isSafeInteger(destinationCompanyId) ||
        !permittedCompanyIds.has(destinationCompanyId)) {
      throw new Error(PROPERTIES_PO_IMPORT_ERRORS.unauthorizedDestination + " " + container.containerNumber);
    }
    const chargeEvidenceReference = selected.chargeEvidenceReference.trim();
    if (selected.chargesConfirmed && container.chargesTotal !== 0 && chargeEvidenceReference.length < 3) {
      throw new Error(PROPERTIES_PO_IMPORT_ERRORS.missingChargeEvidence + " " + container.containerNumber);
    }
    return {
      containerNumber: container.containerNumber,
      destinationCompanyId,
      chargesConfirmed: selected.chargesConfirmed,
      ...(chargeEvidenceReference ? { chargeEvidenceReference } : {}),
    };
  });
}
