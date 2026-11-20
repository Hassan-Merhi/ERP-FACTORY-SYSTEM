# Write-route input validation

Every POST, PUT, PATCH and DELETE route validates its input against a Zod
schema before the handler runs. Unknown fields are rejected.

## How to validate a route

```ts
import { z } from "zod";
import { idParams, validateRequest, validatedInput, type RequestSchemas } from "../lib/validateRequest";
import { insertThingSchema } from "@shared/schema";

const updateThingInput = {
  params: idParams,
  body: insertThingSchema.pick({ name: true, amount: true }).partial().strict(),
} satisfies RequestSchemas;

app.patch("/api/things/:id", requireAuth, validateRequest(updateThingInput), async (req, res) => {
  const { params, body } = validatedInput(req, updateThingInput);
  // params.id is a number; body has only the declared fields.
});
```

Rules:

- Mount `validateRequest` after `requireAuth` and every other `require*` guard,
  and before the handler.
- Declare `params` whenever the path has parameters, and `body` on every
  POST/PUT/PATCH. A DELETE or action POST with no body uses `emptyBody`.
- Object schemas must be strict at every depth (`z.strictObject` or
  `.strict()`). A non-strict object throws when the route is registered.
- Reuse the insert schemas from `shared/schema` (`.pick`, `.omit`, `.partial`,
  then `.strict()`) rather than writing a new shape.
- Protected accounting writes (`shared/voucherPathIdentityPolicy.ts` and
  `client/src/lib/accountingRequestIdentity.ts`) get a `clientRequestId` in
  their JSON body from the browser fetch guard. Declare it with the shared
  `clientRequestId` field, or use `identityOnlyBody` when the route takes no
  other body. `tests/write-route-validation.test.ts` fails when one refuses it.
- `req.body` is replaced by the parsed body. Read parsed `params` and `query`
  through `validatedInput(req, schemas)`.

A failed request gets a 400:

```json
{
  "code": "REQUEST_VALIDATION_FAILED",
  "message": "Invalid request data",
  "errors": [{ "location": "body", "path": "amount", "code": "too_small", "message": "..." }]
}
```

Routes whose clients follow an established refusal contract can keep it:
`validateRequest(schemas, { status: 422, code: "OFFLINE_BROWSER_REQUEST_INVALID" })`
answers with that status and code, with the same `errors` list. The offline
sync routes use this, because the browser and PC sync agents act on their 422
codes.

## How it is enforced

Every write route is validated; there is no baseline or allowance.

- `npm run audit:write-validation` reads `config/route-manifest.json` and fails
  when any unique write route (method + path) has no `validateRequest` in its
  chain. It runs in the Repository Audits job of `ci.yml`, which runs on every
  pull request and is part of the required `Check / Build / Lint / Test`
  status. `--list` prints any offending route; `config/write-validation-tiers.json`
  only groups the report by risk area.
- `config/route-manifest.json` is checked against the live app by
  `tests/route-manifest.test.ts`, so a new route cannot be hidden from the
  audit. After adding or changing a route, run the two manifest tests with
  `UPDATE_ROUTE_MANIFEST=1` and `UPDATE_ROUTE_ACCESS_MANIFEST=1`.
- `tests/write-route-validation.test.ts` checks the live route stack: params
  and body schemas are declared where required, validation runs after the
  guards, and it is never the terminal handler.
- A schema parsed inside the handler does not count. It is invisible to the
  audit and to the strictness check.
