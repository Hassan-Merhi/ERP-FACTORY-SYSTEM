import { History } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { HistoricalOpeningResolver } from "./HistoricalOpeningResolver";

/**
 * Resolves opening and acquisition values whose currency was never recorded.
 * Hidden from the Accounts page (dc0ea9fa0); this route keeps the tool
 * reachable for Admin, Owner and Developer, the roles the save endpoint accepts.
 */
export default function HistoricalOpenings() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Historical opening values"
        subtitle="Record the native currency and historical rate of opening values that were saved without them."
        icon={<History className="h-5 w-5" />}
      />
      <HistoricalOpeningResolver />
    </div>
  );
}
