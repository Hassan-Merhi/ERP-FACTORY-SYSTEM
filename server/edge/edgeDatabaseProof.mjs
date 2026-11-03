/**
 * An edge is not provisioned just because startup created an empty schema.
 * Production accounts/company data must be restored and independently approved.
 * This is a presence check, not cloud replication or cutover attestation.
 */
export async function hasFactoryEdgeData(queryable) {
  try {
    const result = await queryable.query(`
      SELECT
        to_regclass('public.users') IS NOT NULL AS users_table,
        to_regclass('public.companies') IS NOT NULL AS companies_table
    `);
    if (!result.rows?.[0]?.users_table || !result.rows?.[0]?.companies_table) return false;
    const data = await queryable.query(
      "SELECT EXISTS(SELECT 1 FROM public.users) AS users, EXISTS(SELECT 1 FROM public.companies) AS companies"
    );
    return data.rows?.[0]?.users === true && data.rows?.[0]?.companies === true;
  } catch {
    // Missing schema/connection fail closed; never pretend a new DB is ready.
    return false;
  }
}
