import type { Database } from "../src/db.js";

export async function resetArcTestData(db: Database): Promise<void> {
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name LIKE 'arc\\_%' ESCAPE '\\'
        AND table_name NOT IN ('arc_schema_migrations', 'arc_deployment_binding')
      ORDER BY table_name`,
  );
  if (tables.rows.length === 0) return;
  const identifiers = tables.rows
    .map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`)
    .join(", ");
  await db.query(`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`);
}
