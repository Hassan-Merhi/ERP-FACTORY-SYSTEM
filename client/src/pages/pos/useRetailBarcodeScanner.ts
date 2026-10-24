import { useEffect, useRef } from "react";

/**
 * Hardware scanners type the code followed by Enter. When focus is outside an
 * input (e.g. after clicking a button) the keystrokes are captured globally so a
 * scan is never lost.
 */
export function useRetailBarcodeScanner(onScan: (barcode: string) => void) {
  const bufferRef = useRef("");
  const lastKeyAtRef = useRef(0);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], [role='dialog']")) return;
      const now = Date.now();
      if (now - lastKeyAtRef.current > 120) bufferRef.current = "";
      lastKeyAtRef.current = now;

      if (event.key === "Enter") {
        const barcode = bufferRef.current.trim();
        bufferRef.current = "";
        if (barcode.length >= 3) {
          event.preventDefault();
          onScan(barcode);
        }
        return;
      }
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        bufferRef.current += event.key;
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onScan]);
}
