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
import { isCreateOnlyRole, isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";

export const EXISTING_RECORD_CHANGE_DENIED_MESSAGE =
  "Your role can view existing records but cannot change, delete, approve or reverse them.";

export function useExistingRecordChangeAccess(): {
  allowed: boolean;
  isCreateOnly: boolean;
  reason: string | null;
} {
  // Outside a CompanyProvider (isolated component renders) the role is unknown;
  // controls then stay as they were and the server remains authoritative.
  const role = useOptionalCompany()?.selectedCompany?.role ?? null;
  const readOnly = isExistingRecordReadOnlyRole(role);
  return {
    allowed: !readOnly,
    isCreateOnly: isCreateOnlyRole(role),
    reason: readOnly ? EXISTING_RECORD_CHANGE_DENIED_MESSAGE : null,
  };
}
