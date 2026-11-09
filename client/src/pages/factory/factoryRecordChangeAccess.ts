/**
 * Role-based existing-record access for Factory screens whose model already
 * reads the selected company through useCompany(). It mirrors
 * useExistingRecordChangeAccess() without a second context read. Presentation
 * only: the server refuses the same writes whatever the UI shows.
 */
import { EXISTING_RECORD_CHANGE_DENIED_MESSAGE } from "@/hooks/useExistingRecordChangeAccess";
import { isCreateOnlyRole, isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";

export interface FactoryRecordChangeAccess {
  allowed: boolean;
  isCreateOnly: boolean;
  reason: string | null;
}

export function factoryRecordChangeAccess(role: string | null | undefined): FactoryRecordChangeAccess {
  const readOnly = isExistingRecordReadOnlyRole(role ?? null);
  return {
    allowed: !readOnly,
    isCreateOnly: isCreateOnlyRole(role ?? null),
    reason: readOnly ? EXISTING_RECORD_CHANGE_DENIED_MESSAGE : null,
  };
}
