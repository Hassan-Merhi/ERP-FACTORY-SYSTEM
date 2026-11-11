import AccountsLegacy from "./AccountsLegacy";

/** Accounts is a pure page wrapper. Global fetch interceptors must never be
 * installed or restored during render: doing so can break unrelated routes. */
export default function Accounts() {
  return (
    <div className="space-y-4">
      <AccountsLegacy />
    </div>
  );
}
