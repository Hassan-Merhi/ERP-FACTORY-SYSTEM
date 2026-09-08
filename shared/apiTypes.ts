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
