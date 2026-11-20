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

- `npm run audit:write-validation` reads `config/route-manifest.json` and lists
  every unique write route (method + path) without `validateRequest` in its
  chain. `config/write-validation-ratchet.json` holds the count, which may only
  fall: the audit fails above it and below it. After converting routes, run
  `UPDATE_ROUTE_MANIFEST=1` and `UPDATE_ROUTE_ACCESS_MANIFEST=1` for the two
  manifest tests, then `UPDATE_WRITE_VALIDATION_BASELINE=1 npm run audit:write-validation`.
- `tests/write-route-validation.test.ts` checks the live route stack: params
  and body schemas are declared where required, and validation runs after the
  guards.
- A schema parsed inside the handler does not count. It is invisible to the
  audit and to the strictness check.
- The backlog is ordered by risk in the ratchet file's tiers: vouchers and
  posting, stock movements, POS, payroll, settings/admin/auth, the rest of
  the factory routes, then other modules.
