import { pool } from "../db/database.js";

const workerId = `summary-worker-${process.pid}`;

export async function claimSummaryJob() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT id, company_id AS "companyId", call_id AS "callId", attempts
       FROM summary_jobs
       WHERE (status = 'pending' OR (status = 'processing' AND locked_at < NOW() - INTERVAL '10 minutes'))
         AND available_at <= NOW()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const job = result.rows[0];
    if (!job) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE summary_jobs
       SET status = 'processing', attempts = attempts + 1,
           locked_at = NOW(), last_error = NULL
       WHERE id = $1`,
      [job.id],
    );
    await client.query("COMMIT");
    return { ...job, workerId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failSummaryJob(jobId, error) {
  await pool.query(
    `UPDATE summary_jobs
     SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END,
         available_at = NOW() + INTERVAL '1 minute',
         last_error = $2, locked_at = NULL
     WHERE id = $1`,
    [jobId, error.message],
  );
}

export async function completeSummaryJob(jobId) {
  await pool.query(
    `UPDATE summary_jobs
     SET status = 'completed', completed_at = NOW(), locked_at = NULL
     WHERE id = $1`,
    [jobId],
  );
}

if (process.argv[1]?.endsWith("summary.worker.js")) {
  console.log(`${workerId} is ready; summary generation is not configured yet.`);
  process.on("SIGTERM", async () => {
    await pool.end();
    process.exit(0);
  });
}
