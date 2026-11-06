/**
 * Help & Training for each workspace. Every wrapper builds its guide list from
 * the navigation that workspace's sidebar shows the current user.
 */
import HelpTraining from "./HelpTraining";
import { usePosNavigationItems } from "@/app/usePosNavigationItems";
import { useCompany } from "@/contexts/CompanyContext";
import {
  posHelpTopics,
  useErpHelpTopics,
  useFactoryHelpTopics,
  usePropertiesHelpTopics,
} from "@/training/useHelpTrainingTopics";

interface HelpUser {
  username?: string | null;
  role?: string | null;
  currentRole?: string | null;
}

export function ErpHelpTraining({ user }: { user?: HelpUser }) {
  return <HelpTraining mode="erp" topics={useErpHelpTopics(user)} />;
}

export function FactoryHelpTraining({ user }: { user?: HelpUser }) {
  return <HelpTraining mode="factory" topics={useFactoryHelpTopics(user)} />;
}

export function PropertiesHelpTraining({ user }: { user?: HelpUser }) {
  return <HelpTraining mode="properties" topics={usePropertiesHelpTopics(user)} />;
}

export function PosHelpTraining({
  user,
  posImportEnabled,
}: {
  user: { role?: string | null; canAccessCustomers?: boolean };
  posImportEnabled: boolean;
}) {
  const { selectedCompany } = useCompany();
  const items = usePosNavigationItems({
    user,
    posImportEnabled,
    chatUnread: undefined,
    companyType: selectedCompany?.companyType,
  });
  return <HelpTraining mode="pos" topics={posHelpTopics(items)} />;
}
