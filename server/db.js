const { Pool } = require("pg");
const pros = require("./pros");
const events = require("./events");

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
  const { rows: existing } = await pool.query(
    "SELECT to_regclass('pros') IS NOT NULL AS has_pros, to_regclass('event_types') IS NOT NULL AS has_event_types"
  );

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

    CREATE TABLE IF NOT EXISTS pros (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false");
  // Spalte «lektionen_jahr» heisst neu «sollstunden» (Werte bleiben erhalten).
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'pros' AND column_name = 'lektionen_jahr')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'pros' AND column_name = 'sollstunden') THEN
        ALTER TABLE pros RENAME COLUMN lektionen_jahr TO sollstunden;
      END IF;
    END $$;
  `);
  await pool.query(`
    ALTER TABLE pros
      ADD COLUMN IF NOT EXISTS code                    TEXT UNIQUE,
      ADD COLUMN IF NOT EXISTS sollstunden             INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS bambinitraining         BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS kurse                   BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS gce_training            BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS freie_tage              TEXT[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS auslastung_soll_prozent INTEGER NOT NULL DEFAULT 100,
      ADD COLUMN IF NOT EXISTS abwesenheiten           JSONB NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS verfuegbarkeitsregel    TEXT;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_types (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      brutto_min INTEGER NOT NULL CHECK (brutto_min BETWEEN 0 AND 30),
      netto_min  INTEGER NOT NULL CHECK (netto_min BETWEEN 0 AND 30),
      color      TEXT NOT NULL DEFAULT '#6a8fd8',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id         SERIAL PRIMARY KEY,
      type_id    INTEGER NOT NULL REFERENCES event_types(id) ON DELETE RESTRICT,
      pro_id     INTEGER NOT NULL REFERENCES pros(id) ON DELETE CASCADE,
      date       DATE NOT NULL,
      start_min  INTEGER NOT NULL,
      end_min    INTEGER NOT NULL,
      notiz      TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (start_min >= 0 AND end_min <= 1440 AND end_min > start_min)
    );
    CREATE INDEX IF NOT EXISTS events_date_idx ON events (date);
    CREATE INDEX IF NOT EXISTS events_pro_date_idx ON events (pro_id, date);
  `);

  // Start-Event-Typen nur beim erstmaligen Anlegen der Tabelle einfügen.
  if (!existing[0].has_event_types) {
    for (const [i, t] of events.SEED_TYPES.entries()) {
      await pool.query(
        "INSERT INTO event_types (name, brutto_min, netto_min, color, sort_order) VALUES ($1, $2, $3, $4, $5)",
        [t.name, t.brutto_min, t.netto_min, t.color, i + 1]
      );
    }
  }

  await pool.query("DELETE FROM sessions WHERE expires_at < now()");

  // Start-Pros nur beim erstmaligen Anlegen der Tabelle einfügen.
  if (!existing[0].has_pros) {
    const names = ["Thore", "Yannick", "Anja", "Benedikt", "Aaron", "Joseph", "Leigh"];
    for (const [i, name] of names.entries()) {
      await pool.query("INSERT INTO pros (name, sort_order) VALUES ($1, $2)", [name, i + 1]);
    }
  }

  // Startwerte einmalig übernehmen: nur für Pros, die noch kein Kürzel haben.
  // Spätere Änderungen durch Admins bleiben dadurch erhalten.
  for (const seed of pros.SEED) {
    const cols = pros.COLUMNS.filter((c) => c !== "name");
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
    const vals = pros.values(seed).filter((_, i) => pros.COLUMNS[i] !== "name");
    await pool.query(
      `UPDATE pros SET ${sets}
        WHERE name = $${cols.length + 1} AND code IS NULL
          AND NOT EXISTS (SELECT 1 FROM pros WHERE code = $1)`,
      [...vals, seed.name]
    );
  }
}

module.exports = { pool, migrate };
