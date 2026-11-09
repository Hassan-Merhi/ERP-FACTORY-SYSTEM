/**
 * Factory-only UI defaults. Never write these fallback values to the database.
 * Company-specific values must come from the selected-company settings response.
 */
export interface FactoryRenameDefaults {
  codePrefix: string;
  find: string;
  replace: string;
}
export interface FactoryCompanyUiSettings {
  /** Optional future server-provided preference; absent in legacy settings. */
  renameCodePrefix?: string | null;
}
export const LEGACY_FACTORY_RENAME_DEFAULTS: Readonly<FactoryRenameDefaults> = {
  codePrefix: "HMD13",
  find: "-",
  replace: " ",
};
export function factoryRenameDefaults(settings?: FactoryCompanyUiSettings | null): FactoryRenameDefaults {
  return {
    ...LEGACY_FACTORY_RENAME_DEFAULTS,
    codePrefix: settings?.renameCodePrefix?.trim() || LEGACY_FACTORY_RENAME_DEFAULTS.codePrefix,
  };
}
