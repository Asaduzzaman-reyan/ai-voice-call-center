import { pool } from "../db/database.js";
import { env } from "../config/env.js";

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

async function getJobTranscript(jobId) {
  const result = await pool.query(
    `SELECT j.id, j.company_id AS "companyId", j.call_id AS "callId",
            c.conversation_id AS "conversationId",
            COALESCE(
              json_agg(
                json_build_object('speaker', m.speaker, 'transcript', m.transcript)
                ORDER BY m.created_at, m.id
              ) FILTER (WHERE m.id IS NOT NULL),
              '[]'::json
            ) AS messages
     FROM summary_jobs j
     JOIN calls c ON c.id = j.call_id
     LEFT JOIN conversation_messages m ON m.conversation_id = c.conversation_id
     WHERE j.id = $1
     GROUP BY j.id, c.conversation_id`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

async function generateSummary(messages) {
  const transcript = messages
    .map(({ speaker, transcript }) => `${speaker.toUpperCase()}: ${transcript}`)
    .join("\n");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openAiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.summaryModel,
      input: [
        {
          role: "system",
          content:
            "Summarize the call. Return only valid JSON matching the requested schema. Do not invent facts not present in the transcript.",
        },
        {
          role: "user",
          content: transcript || "No transcript was captured.",
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "call_summary",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              customer_intent: { type: "string" },
              resolution_status: { type: "string" },
              follow_up_required: { type: "boolean" },
              follow_up_notes: { type: ["string", "null"] },
            },
            required: [
              "summary",
              "customer_intent",
              "resolution_status",
              "follow_up_required",
              "follow_up_notes",
            ],
          },
        },
      },
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "Summary generation failed");
  }
  const outputText = payload.output_text;
  if (typeof outputText !== "string" || !outputText.trim()) {
    throw new Error("Summary response did not contain structured output");
  }
  return JSON.parse(outputText);
}

async function saveSummary(job, summary) {
  await pool.query(
    `INSERT INTO call_summaries
       (id, company_id, call_id, summary, customer_intent, resolution_status,
        follow_up_required, follow_up_notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (call_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       customer_intent = EXCLUDED.customer_intent,
       resolution_status = EXCLUDED.resolution_status,
       follow_up_required = EXCLUDED.follow_up_required,
       follow_up_notes = EXCLUDED.follow_up_notes,
       updated_at = NOW()`,
    [
      crypto.randomUUID(),
      job.companyId,
      job.callId,
      summary.summary,
      summary.customer_intent,
      summary.resolution_status,
      summary.follow_up_required,
      summary.follow_up_notes,
    ],
  );
}

export async function processNextSummaryJob() {
  const job = await claimSummaryJob();
  if (!job) return false;
  try {
    const transcriptJob = await getJobTranscript(job.id);
    if (!transcriptJob) throw new Error("Summary job data no longer exists");
    const summary = await generateSummary(transcriptJob.messages);
    await saveSummary(job, summary);
    await completeSummaryJob(job.id);
    return true;
  } catch (error) {
    await failSummaryJob(job.id, error);
    console.error(`Summary job ${job.id} failed:`, error.message);
    return false;
  }
}

if (process.argv[1]?.endsWith("summary.worker.js")) {
  console.log(`${workerId} is ready.`);
  const run = async () => {
    await processNextSummaryJob();
  };
  const timer = setInterval(() => {
    run().catch((error) => console.error("Summary worker error:", error));
  }, 5000);
  process.on("SIGTERM", async () => {
    clearInterval(timer);
    await pool.end();
    process.exit(0);
  });
}
