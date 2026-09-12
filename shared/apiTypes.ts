/**
 * How a server value looks after it has crossed HTTP.
 *
 * A route hands Express a database row and Express runs it through
 * `JSON.stringify`. That is not an identity transform: a `Date` column reaches
 * the client as an ISO string, and a property whose value is `undefined`
 * disappears. Typing a client query as the raw row type therefore claims a
 * `Date` the client never receives, which is exactly the kind of quiet
 * mismatch an `any` used to hide.
 *
 * `Serialized<T>` describes what the client actually receives, so a row type
 * from `@shared/schema` can be reused on the client without lying about it.
 */
export type Serialized<T> = T extends Date
  ? string
  : T extends (infer TElement)[]
    ? Serialized<TElement>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;

/** GET /api/factory/my-access */
export type FactoryMyAccess = {
  fullAccess: boolean;
  pageKeys: string[];
  hasErpAccess: boolean;
  hasFactoryAccess: boolean;
  hiddenCostFields: string[];
  hideAllCosts: boolean;
  companyId: number;
  companyName: string;
};

/** GET /api/auth/me — user row minus password, plus session fields. */
export type AuthMe = {
  id: string | number;
  username?: string | null;
  fullName?: string | null;
  active?: boolean;
  chatbotEnabled?: boolean;
  hiddenErpCostFields?: string[];
  createdAt?: string;
  currentRole?: string | null;
  role?: string | null;
  currentCompanyId?: number | null;
  currentLocationId?: number | null;
  currentPOSStation?: number | null;
  assignedLocationId?: number | null;
  posStation?: string | number | null;
  cashAccountId?: number | null;
  canSellNegativeStock?: boolean;
  posViewOnly?: boolean;
  daybookEditDays?: number | null;
  canAccessCustomers?: boolean;
  canDeleteRecords?: boolean;
};

/**
 * List-row shape for client queries that historically used `any[]`.
 * Extra API fields remain accessible without reintroducing `any`.
 */
export type ApiListRow = {
  id?: number | string | null;
  name?: string | null;
  code?: string | null;
  type?: string | null;
  status?: string | null;
  active?: boolean | null;
  companyId?: number | null;
  [key: string]: unknown;
};
