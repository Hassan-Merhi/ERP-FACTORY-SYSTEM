// Extracted from ./useLoadingOrderMutations.ts
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import type { useToast } from "@/hooks/use-toast";
import type { FactoryContainerLoadingTranslationKey } from "@/i18n/factoryContainerLoadingTranslations";
import type { getApiRequest } from "@/lib/factoryApi";

type LastScannedRef = { baleReference: string; baleName: string; articleCode: string } | null;

export interface LoadingOrderMutationsInput {
  orderId: number | null;
  selectedLocationId: string;
  capacityProformaId: number | null;
  modeApiRequest: ReturnType<typeof getApiRequest>;
  toast: ReturnType<typeof useToast>["toast"];
  tr: (key: FactoryContainerLoadingTranslationKey, params?: Record<string, string | number>) => string;
  navigate: (to: string) => void;
  refreshSharedLoadingQueues: () => void;
  scannerRef: RefObject<HTMLInputElement | null>;
  ignoreProformaRef: MutableRefObject<boolean>;
  setBaleToDelete: Dispatch<SetStateAction<{ id: number; baleReference: string } | null>>;
  setShowEmptyContainerConfirm: Dispatch<SetStateAction<boolean>>;
  setLastScannedRef: Dispatch<SetStateAction<LastScannedRef>>;
  setShowLastScannedPopup: Dispatch<SetStateAction<boolean>>;
  setPendingBypassBaleRef: Dispatch<SetStateAction<string | null>>;
  setPendingBypassOverloadRef: Dispatch<SetStateAction<string | null>>;
  setExpandedGroups: Dispatch<SetStateAction<Set<string>>>;
  setScanCode: Dispatch<SetStateAction<string>>;
  setShowImportDialog: Dispatch<SetStateAction<boolean>>;
  setImportPreview: Dispatch<SetStateAction<Array<{ articleCode: string; qty: number }>>>;
  setImportRefNumbers: Dispatch<SetStateAction<string[]>>;
  setOrderId: Dispatch<SetStateAction<number | null>>;
  setIsResuming: Dispatch<SetStateAction<boolean>>;
  setLoadingNote: Dispatch<SetStateAction<string>>;
  setShowFinalizeDialog: Dispatch<SetStateAction<boolean>>;
}
