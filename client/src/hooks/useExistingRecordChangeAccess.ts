/**
 * Whether the active company role may change EXISTING business records.
 *
 * View Only and Create Only never edit, delete, approve or reverse existing
 * records; Create Only may still add handler-verified new records (see
 * useCan's createOnlyCreate option). The role is re-read whenever the user
 * switches company. This is presentation only: the server refuses the same
 * writes whatever the UI shows.
 */
import { useOptionalCompany } from "@/contexts/CompanyContext";
import {
  isCreateOnlyRole,
  isCreateOnlyVerifiedSignature,
  isExistingRecordReadOnlyRole,
} from "@shared/createOnlyRolePolicy";

export const EXISTING_RECORD_CHANGE_DENIED_MESSAGE =
  "Your role can view existing records but cannot change, delete, approve or reverse them.";

export interface ExistingRecordChangeAccess {
  /** False for View Only and Create Only: hide or disable controls that change existing records. */
  allowed: boolean;
  isCreateOnly: boolean;
  /** Explanation to show on a disabled control (null when allowed). */
  reason: string | null;
  /**
   * Whether a control that CREATES a new record by `METHOD /api/path` may be
   * shown. Every role except View Only and Create Only may; Create Only only
   * for handler-verified creates; View Only never.
   */
  canCreate: (method: string, path: string) => boolean;
}

export function useExistingRecordChangeAccess(): ExistingRecordChangeAccess {
  // Outside a CompanyProvider (isolated component renders) the role is unknown;
  // controls then stay as they were and the server remains authoritative.
  const role = useOptionalCompany()?.selectedCompany?.role ?? null;
  const readOnly = isExistingRecordReadOnlyRole(role);
  const isCreateOnly = isCreateOnlyRole(role);
  return {
    allowed: !readOnly,
    isCreateOnly,
    reason: readOnly ? EXISTING_RECORD_CHANGE_DENIED_MESSAGE : null,
    canCreate: (method, path) => !readOnly || (isCreateOnly && isCreateOnlyVerifiedSignature(method, path)),
  };
}
