import { promisify } from "node:util";
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { pool } from "../db/database.js";

const scrypt = promisify(scryptCallback);
const sessionLifetimeMs = 1000 * 60 * 60 * 24 * 7;

export async function registerUser({ companyName, email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const company = await client.query(
      `INSERT INTO companies (id, name)
       VALUES ($1, $2)
       RETURNING id, name`,
      [randomUUID(), companyName.trim()],
    );
    const companyId = company.rows[0].id;
    const user = await client.query(
      `INSERT INTO users (id, company_id, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, company_id AS "companyId", email, role`,
      [randomUUID(), companyId, normalizedEmail, passwordHash],
    );
    await client.query(
      `INSERT INTO agents (id, company_id, slug, name, instructions)
       VALUES
         ($1, $2, 'customer-support', 'Customer Support',
           'You are a concise, friendly customer support voice agent. Never invent customer information.'),
         ($3, $2, 'sales', 'Sales',
           'You are a helpful sales voice agent. Never invent prices or product features.'),
         ($4, $2, 'billing', 'Billing',
           'You are a professional billing voice agent. Never expose another customer''s financial information.')
       ON CONFLICT (company_id, slug) DO NOTHING`,
      [randomUUID(), companyId, randomUUID(), randomUUID()],
    );
    await client.query("COMMIT");
    return createSession(user.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      error.statusCode = 409;
      error.message = "An account with this email already exists for this company.";
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function loginUser({ email, password }) {
  const result = await pool.query(
    `SELECT id, company_id AS "companyId", email, role, password_hash AS "passwordHash"
     FROM users WHERE email = $1`,
    [email.trim().toLowerCase()],
  );
  const user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    const error = new Error("Invalid email or password");
    error.statusCode = 401;
    throw error;
  }
  delete user.passwordHash;
  return createSession(user);
}

export async function getUserBySession(sessionId) {
  if (!sessionId) return null;
  const result = await pool.query(
    `SELECT u.id, u.company_id AS "companyId", u.email, u.role
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > NOW()`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function deleteSession(sessionId) {
  if (sessionId) await pool.query("DELETE FROM auth_sessions WHERE id = $1", [sessionId]);
}

async function createSession(user) {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
    [sessionId, user.id],
  );
  return { sessionId, user };
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derivedKey).toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [, salt, expectedHex] = storedHash.split(":");
  if (!salt || !expectedHex) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
