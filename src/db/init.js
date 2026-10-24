import { pool, initializeDatabase } from "./database.js";

try {
  await initializeDatabase();
  console.log("Database schema is ready.");
} finally {
  await pool.end();
}
