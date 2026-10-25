import { pool } from "../db/database.js";

export async function listAgents(companyId) {
  const result = await pool.query(
    `SELECT slug AS id, slug AS "agentId", name, instructions, enabled
     FROM agents
     WHERE company_id = $1 AND enabled = TRUE
     ORDER BY name`,
    [companyId],
  );
  return result.rows;
}

export async function listCalls(companyId) {
  const result = await pool.query(
    `SELECT ca.id AS "callId", ca.status, ca.started_at AS "startedAt",
            ca.ended_at AS "endedAt", ca.duration_seconds AS "durationSeconds",
            ca.termination_reason AS "terminationReason",
            c.id AS "conversationId", a.name AS "agentName",
            cs.summary, cs.resolution_status AS "resolutionStatus",
            cs.follow_up_required AS "followUpRequired"
     FROM calls ca
     JOIN conversations c ON c.id = ca.conversation_id
     JOIN agents a ON a.id = c.agent_id
     LEFT JOIN call_summaries cs ON cs.call_id = ca.id
     WHERE ca.company_id = $1
     ORDER BY ca.started_at DESC
     LIMIT 100`,
    [companyId],
  );
  return result.rows;
}

export async function updateAgent(companyId, agentId, updates) {
  const result = await pool.query(
    `UPDATE agents
     SET name = $3, instructions = $4, enabled = $5
     WHERE company_id = $1 AND (id::text = $2 OR slug = $2)
     RETURNING id, slug AS "agentId", name, instructions, enabled`,
    [companyId, agentId, updates.name, updates.instructions, updates.enabled],
  );
  return result.rows[0] ?? null;
}

export async function getAgent(companyId, agentId) {
  const result = await pool.query(
    `SELECT id, slug AS "agentId", name, instructions
     FROM agents
     WHERE company_id = $1 AND (id::text = $2 OR slug = $2) AND enabled = TRUE`,
    [companyId, agentId],
  );
  return result.rows[0] ?? null;
}

export async function createConversation({ companyId, agentId, providerCallId = null }) {
  const client = await pool.connect();
  const conversationId = crypto.randomUUID();
  const callId = crypto.randomUUID();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO conversations (id, company_id, agent_id)
       VALUES ($1, $2, $3)
       RETURNING id, company_id AS "companyId", agent_id AS "agentId", created_at AS "createdAt"`,
      [conversationId, companyId, agentId],
    );
    await client.query(
      `INSERT INTO calls (id, company_id, conversation_id, provider_call_id)
       VALUES ($1, $2, $3, $4)`,
      [callId, companyId, conversationId, providerCallId],
    );
    await client.query("COMMIT");
    return { ...result.rows[0], callId, messages: [] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getConversation(companyId, conversationId) {
  const conversationResult = await pool.query(
    `SELECT c.id, c.company_id AS "companyId", c.agent_id AS "agentId",
            c.created_at AS "createdAt", a.name AS "agentName",
            ca.id AS "callId", ca.status AS "callStatus",
            ca.started_at AS "startedAt", ca.ended_at AS "endedAt",
            ca.duration_seconds AS "durationSeconds",
            ca.termination_reason AS "terminationReason",
            cs.summary, cs.customer_intent AS "customerIntent",
            cs.resolution_status AS "resolutionStatus",
            cs.follow_up_required AS "followUpRequired",
            cs.follow_up_notes AS "followUpNotes"
     FROM conversations c
     JOIN agents a ON a.id = c.agent_id
     JOIN calls ca ON ca.conversation_id = c.id
     LEFT JOIN call_summaries cs ON cs.call_id = ca.id
     WHERE c.id = $1 AND c.company_id = $2`,
    [conversationId, companyId],
  );
  const conversation = conversationResult.rows[0];
  if (!conversation) return null;

  const messages = await pool.query(
    `SELECT id, speaker, transcript, provider_item_id AS "providerItemId",
            created_at AS "createdAt"
     FROM conversation_messages
     WHERE conversation_id = $1
     ORDER BY created_at, id`,
    [conversationId],
  );
  return { ...conversation, messages: messages.rows };
}

export async function endCall(companyId, callId, terminationReason = "client_stopped") {
  const result = await pool.query(
    `UPDATE calls
     SET status = 'completed',
         ended_at = COALESCE(ended_at, NOW()),
         duration_seconds = EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))::INTEGER,
         termination_reason = $3
     WHERE id = $1 AND company_id = $2 AND status = 'active'
     RETURNING id, conversation_id AS "conversationId", status, started_at AS "startedAt",
               ended_at AS "endedAt", duration_seconds AS "durationSeconds"`,
    [callId, companyId, terminationReason],
  );
  const call = result.rows[0];
  if (!call) return null;

  await pool.query(
    `INSERT INTO summary_jobs (id, company_id, call_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (call_id) DO NOTHING`,
    [crypto.randomUUID(), companyId, call.id],
  );
  return call;
}

export async function appendMessage(companyId, conversationId, message) {
  const result = await pool.query(
    `INSERT INTO conversation_messages
       (id, conversation_id, speaker, transcript, provider_item_id)
    SELECT $6, c.id, $3, $4, $5
     FROM conversations c
     WHERE c.id = $1 AND c.company_id = $2
     ON CONFLICT (conversation_id, provider_item_id)
       DO NOTHING
     RETURNING id`,
    [
      conversationId,
      companyId,
      message.speaker,
      message.transcript,
      message.providerItemId ?? null,
      crypto.randomUUID(),
    ],
  );
  if (!result.rowCount) return getConversation(companyId, conversationId);
  return getConversation(companyId, conversationId);
}
