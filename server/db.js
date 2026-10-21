const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL ist nicht gesetzt.");
  process.exit(1);
}

// Render: interne Datenbank-URL braucht kein SSL, die externe schon.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// Schema wird beim Start angelegt bzw. ergänzt.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user', 'admin')),
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query("DELETE FROM sessions WHERE expires_at < now()");
}

module.exports = { pool, migrate };
