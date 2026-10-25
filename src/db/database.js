import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "../config/env.js";

const { Pool } = pg;
export const pool = new Pool({ connectionString: env.databaseUrl });

export async function initializeDatabase() {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const schema = await readFile(path.join(currentDirectory, "schema.sql"), "utf8");
  await pool.query(schema);
}

export async function markStaleCalls() {
  const result = await pool.query(
    `UPDATE calls
     SET status = 'failed',
         ended_at = NOW(),
         duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER,
         termination_reason = 'connection_timeout'
     WHERE status = 'active' AND started_at < NOW() - INTERVAL '2 hours'
     RETURNING id, company_id AS "companyId"`,
  );

  for (const call of result.rows) {
    await pool.query(
      `INSERT INTO summary_jobs (id, company_id, call_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (call_id) DO NOTHING`,
      [crypto.randomUUID(), call.companyId, call.id],
    );
  }
  return result.rowCount;
}
