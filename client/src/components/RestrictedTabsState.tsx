import { LockKeyhole } from "lucide-react";

import { EmptyState } from "@/components/ui/page-state";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";

export function RestrictedTabsState() {
  const { t } = useApplicationLanguage();

  return (
    <EmptyState
      className="m-4"
      icon={LockKeyhole}
      title={t("access.noTabsAvailable")}
      data-testid="restricted-tabs-state"
    />
  );
}
