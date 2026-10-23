# ERP Tester user role

**ERP Tester** is an ordinary company-scoped role, available alongside Admin, Manager, POS, and Normal User in **Settings → Users → Add Role / Edit Role**. It can be assigned to **any existing company**, including an operational or production company; **creating a special test company is not required**.

- Choose the user, choose whichever company should be accessible, and select **ERP Tester**.
- ERP Tester has Manager-level operational API access where routes use standard role middleware, and receives ERP operational page access. The role can create/edit data inside the company it is assigned to, subject to standard permissions.
- **System Settings, personal My Settings, user administration, and administrative APIs are forbidden**, including direct URL/API attempts. Configurable role permissions cannot re-enable Settings.
- Permissions are **company-scoped**. The user only sees companies for which they have a membership; the role does not automatically grant membership in other companies.
- Users with ERP Tester assigned in a live company will create or change **real records** there; this is **not** an isolated preview or rollback. For safe testing, create a separate company first.

## Optional one-step isolated company

**Settings → Companies → Create ERP Test Company** still exists for users who want a blank, standalone company and a dedicated login created together.

- This optional action generates a new company and an ERP Tester account in that company, with a one-time password.
- The optional standalone test company still uses extra role-permission restrictions to keep it ERP-focused.
- Existing company accounting records are not modified by provisioning the new standalone company.

## Verification after deployment

1. In **Settings → Users**, create a new login or select an existing one. Assign **ERP Tester** to any company, without an ERPTEST-prefixed company code.
2. Sign in as the Tester. Confirm the intended assigned company is available and unauthorized companies remain inaccessible.
3. Verify the operational ERP pages work and permitted create/edit actions succeed in that company.
4. Confirm Settings and My Settings are hidden, direct visits to `/settings` and `/my-settings` redirect away, and `GET /api/users`, `GET /api/settings/role-permissions`, and `PUT /api/settings/role-permissions` return HTTP 403.
5. Confirm legitimate operational APIs (for example `/api/vouchers`) are not globally blocked for ERP Tester. Check company isolation and an existing normal role for regression.

No new SQL migration is required because `user_company_roles.role` is a text field. Merging the code does not itself create a user or change the roles of existing users.
