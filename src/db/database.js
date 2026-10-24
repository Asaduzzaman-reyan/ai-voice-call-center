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
