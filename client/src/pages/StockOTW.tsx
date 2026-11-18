import { useState } from "react";
import { StockOTWContent } from "./StockOTWContent";

export default function StockOTW() {
  const [showCombined, setShowCombined] = useState(false);
  return <StockOTWContent showCombined={showCombined} onToggleCombined={() => setShowCombined((v) => !v)} />;
}
