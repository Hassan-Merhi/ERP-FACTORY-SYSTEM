# ERP test company and tester account

An administrator or Developer can use **Settings → Companies → Create ERP Test Company** to provision a test tenant.

- The company starts as an empty, standalone ERP company with USD base currency and no parent company.
- The tester has a **ERP Tester** role **only in that new company**, with access to ERP operational pages, customer operations, and data-entry permissions.
- The tester is **not** an Admin or Developer. The ERP administrative Settings route, settings tools, Factory production and Properties are not available. The personal **My Settings** page is also hidden. Password changes remain available via the authenticated API for account security.
- Existing production companies, vouchers, inventories, and company-wide permissions are not changed. The tester does not receive membership in any existing company.
- The provisioning administrator is added as an Admin in the new test company (a Developer already has global access).
- The tester password is generated randomly and shown once. The administrator must copy it before dismissing the dialog.

## Verification after deployment

1. As Admin/Developer, provision a uniquely named test company and copy its one-time credentials. The provisioned user has the **ERP Tester** role.
2. Sign in as the tester in a separate browser session. Confirm only the newly created company is selectable.
3. Add and edit sample stock items, a supplier, a customer, and a test voucher in this new company.
4. Confirm **Settings** and **My Settings** are absent from ERP navigation and that visiting either path directly redirects away.
5. Confirm direct calls to Settings/admin endpoints (for example, **GET /api/settings/role-permissions**, **GET /api/users**, and **PUT /api/settings/role-permissions**) return HTTP 403.
6. Confirm the changes are visible only in the test company. An administrator should inspect that production companies have no new vouchers or inventory changes.

You can also create a user normally in **Settings → Users**, then assign the **ERP Tester** role from the same role selector as POS, Manager, and Admin. Choose a standalone ERP test company; production company IDs are rejected server-side. The role automatically receives operational ERP page grants.

This feature only creates the provisioning action in source code. **Merging or deploying it does not create a company or login by itself**; an administrator must click the action. Never reuse this account for real production transactions.
