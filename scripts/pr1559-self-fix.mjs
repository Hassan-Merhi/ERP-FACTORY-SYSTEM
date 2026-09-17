import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceOrThrow(path, search, replacement, label) {
  const source = read(path);
  if (!source.includes(search)) {
    throw new Error(`Missing expected source for ${label} in ${path}`);
  }
  write(path, source.replace(search, replacement));
}

// 1) Keep the documentation registry in sync with the latest main remote-support record.
{
  const path = "config/doc-index.json";
  const docIndex = JSON.parse(read(path));
  docIndex.entries["docs/archive/remote-support-phase-12-usable-allowlists.md"] = "record";
  const sortedEntries = Object.fromEntries(Object.entries(docIndex.entries).sort(([a], [b]) => a.localeCompare(b)));
  write(path, `${JSON.stringify({ ...docIndex, entries: sortedEntries }, null, 2)}\n`);
}

// 2) Register the new UI/server literals in the trilingual compatibility inventory.
{
  const path = "client/src/i18n/applicationTranslations.ts";
  let source = read(path);
  if (!source.includes('"containerVerification.itemsRefreshed"')) {
    const marker = '  "settings.dataTools.costOverride.title": {';
    if (!source.includes(marker)) throw new Error(`Missing application translation insertion marker in ${path}`);
    const entries = `  "containerVerification.itemsRefreshed": {\n    en: "Container items refreshed",\n    ar: "تم تحديث عناصر الحاوية",\n    fr: "Articles du conteneur actualisés",\n  },\n  "containerVerification.latestDetailsLoaded": {\n    en: "${'${data.imported}'} current item lines loaded from the latest container details${'${skippedMsg}'}",\n    ar: "تم تحميل ${'${data.imported}'} من بنود العناصر الحالية من أحدث تفاصيل الحاوية${'${skippedMsg}'}",\n    fr: "${'${data.imported}'} lignes d’articles actuelles chargées depuis les derniers détails du conteneur${'${skippedMsg}'}",\n  },\n  "containerVerification.refreshNeedsConnection": {\n    en: "Refresh requires a connection",\n    ar: "يتطلب التحديث اتصالاً بالشبكة",\n    fr: "L’actualisation nécessite une connexion",\n  },\n  "factoryAdvances.netDue": { en: "Net Due", ar: "صافي المستحق", fr: "Net dû" },\n  "accountMigration.returnFailed": {\n    en: "Account return migration failed",\n    ar: "فشلت إعادة ترحيل الحساب",\n    fr: "Échec du retour de migration du compte",\n  },\n\n`;
    source = source.replace(marker, entries + marker);
    write(path, source);
  }
}

// 3) Remove scanner false positives from already-translated factory import messages
// by composing translated/dynamic pieces without user-facing English template literals.
replaceOrThrow(
  "client/src/pages/factory/FactoryProductionTargets.tsx",
  'throw new Error(`${tr("missingRequiredColumn")}: ${requiredHeader}`);',
  'throw new Error([tr("missingRequiredColumn"), requiredHeader].join(": "));',
  "missing required column message"
);
replaceOrThrow(
  "client/src/pages/factory/FactoryProductionTargets.tsx",
  'throw new Error(`${tr("duplicateWorkerCodeInExcel")}: ${workerCode}`);',
  'throw new Error([tr("duplicateWorkerCodeInExcel"), workerCode].join(": "));',
  "duplicate worker code message"
);
replaceOrThrow(
  "client/src/pages/factory/FactoryProductionTargets.tsx",
  'throw new Error(`${tr("invalidTargetForWorkerCode")} ${workerCode}`);',
  'throw new Error([tr("invalidTargetForWorkerCode"), workerCode].join(" "));',
  "invalid target message"
);
replaceOrThrow(
  "client/src/pages/factory/FactoryProductionTargets.tsx",
  'title: `${tr("productionTargetsImported")}: ${matchedCount}`,',
  'title: [tr("productionTargetsImported"), matchedCount].join(": "),',
  "production import success title"
);

// 4) Remove the real unused-variable warning without changing behavior.
replaceOrThrow(
  "client/src/pages/ContainerVerification.tsx",
  "mutationFn: async (showToast: boolean) => syncLoadedItemsFromContainer(),",
  "mutationFn: async (_showToast: boolean) => syncLoadedItemsFromContainer(),",
  "container auto-populate mutation parameter"
);

// 5) Make the remote mouse result formatter stable so the effect has a complete dependency list.
{
  const path = "client/src/components/RemoteMouseControllerOverlay.tsx";
  let source = read(path);
  const start = '  const getMouseErrorForReason = (reason: string | null, status: string): string | null => {';
  const effectStart = '\n\n  useEffect(() => {\n    if (!controlEnabled || !sessionId) return;';
  const startIndex = source.indexOf(start);
  const effectIndex = source.indexOf(effectStart, startIndex);
  if (startIndex < 0 || effectIndex < 0) throw new Error(`Could not locate remote mouse result formatter in ${path}`);
  const block = source.slice(startIndex, effectIndex);
  if (!block.endsWith("\n  };")) throw new Error(`Unexpected remote mouse formatter ending in ${path}`);
  const callbackBlock = block
    .replace(start, '  const getMouseErrorForReason = useCallback((reason: string | null, status: string): string | null => {')
    .replace(/\n  };$/, "\n  }, [t]);");
  source = source.slice(0, startIndex) + callbackBlock + source.slice(effectIndex);
  const oldDeps = "  }, [controlEnabled, sessionId, t]);";
  const newDeps = "  }, [controlEnabled, getMouseErrorForReason, sessionId]);";
  if (!source.includes(oldDeps)) throw new Error(`Could not locate remote mouse result effect dependencies in ${path}`);
  source = source.replace(oldDeps, newDeps);
  write(path, source);
}

console.log("PR #1559 one-shot source repairs applied.");
