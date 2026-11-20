// Shared Phase 6 automatic-HADI pair, cash-account selection and error types.
// The live automatic collection is postGoldenCoastAutomaticHadiCollectionTx in
// ./goldenCoastPhase6AutoHadi.ts.
export {
  GoldenCoastPhase6AutoHadiError,
  resolveGoldenCoastAutomaticHadiPair,
  selectGoldenCoastAutomaticHadiCashAccount,
} from "./resolveGoldenCoastAutomaticHadiPair";
export type {
  GoldenCoastAutomaticHadiAccount,
  GoldenCoastAutomaticHadiPair,
  GoldenCoastAutomaticHadiResult,
} from "./resolveGoldenCoastAutomaticHadiPair";
