import { MhdViewManager } from "./factorysettings/MhdViewManager";

/** Admin-accessible MHD manager; other Intelligence tools remain developer-only. */
export default function FactoryMhdViewManagerPage() {
  return (
    <main className="mx-auto max-w-5xl p-3 sm:p-6" data-testid="factory-mhd-view-manager-page">
      <MhdViewManager />
    </main>
  );
}
