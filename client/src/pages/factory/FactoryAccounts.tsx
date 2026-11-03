import Accounts from "@/pages/Accounts";
import { FactoryRelatedLinks } from "@/components/FactoryRelatedLinks";

export default function FactoryAccounts() {
  return (
    <div className="min-w-0">
      <FactoryRelatedLinks
        className="mb-3 justify-end"
        links={[{ href: "/factory/cost-centers", label: "Cost Centers" }]}
      />
      <Accounts />
    </div>
  );
}
