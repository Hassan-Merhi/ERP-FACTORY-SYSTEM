// Extracted from ./WhatsAppExportSection.tsx

export interface WaSettings {
  instanceId: string;
  apiToken: string;
  enabled: boolean;
  hasCredentials: boolean;
}

export interface Recipient {
  id: number;
  chatId: string;
  name: string;
  isGroup: boolean;
  active: boolean;
}

export interface GreenChat {
  id: string;
  name: string;
  type: string;
}

export type InstanceState =
  "authorized" | "notAuthorized" | "sleepMode" | "starting" | "yellowCard" | "notConfigured" | "unknown";
