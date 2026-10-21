// Versionsverlauf: Nach jeder erfolgreichen Änderung an Pros, Event-Typen oder Events
// wird der gesamte Datenstand als Version gespeichert. Eine Version lässt sich
// wiederherstellen; das Wiederherstellen ist selbst wieder eine Version.
// Benutzerkonten sind bewusst ausgenommen (Passwörter, Zugänge).

const { pool } = require("./db");

const KEEP_VERSIONS = 1000;

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS versions (
      id          SERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor       TEXT NOT NULL,
      description TEXT NOT NULL,
      data        JSONB NOT NULL
    );
  `);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM versions");
  if (rows[0].n === 0) await record("System", "Ausgangsstand");
}

async function snapshot(db) {
  const { rows } = await db.query(`
    SELECT
      (SELECT coalesce(jsonb_agg(p ORDER BY p.id), '[]') FROM pros p)        AS pros,
      (SELECT coalesce(jsonb_agg(t ORDER BY t.id), '[]') FROM event_types t) AS event_types,
      (SELECT coalesce(jsonb_agg(e ORDER BY e.id), '[]') FROM events e)      AS events
  `);
  return rows[0];
}

async function record(actor, description, db = pool) {
  const data = await snapshot(db);
  await db.query("INSERT INTO versions (actor, description, data) VALUES ($1, $2, $3)", [actor, description, data]);
  await db.query(
    "DELETE FROM versions WHERE id NOT IN (SELECT id FROM versions ORDER BY id DESC LIMIT $1)",
    [KEEP_VERSIONS]
  );
}

async function list() {
  const { rows } = await pool.query(`
    SELECT id, created_at, actor, description,
           jsonb_array_length(data->'pros') AS pros,
           jsonb_array_length(data->'event_types') AS event_types,
           jsonb_array_length(data->'events') AS events
      FROM versions ORDER BY id DESC
  `);
  return rows;
}

// Setzt Pros, Event-Typen und Events auf den Stand der Version zurück.
async function restore(versionId, actor) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query("SELECT id, created_at, data FROM versions WHERE id = $1", [versionId]);
    if (!rows[0]) {
      await db.query("ROLLBACK");
      return null;
    }
    const { data } = rows[0];
    const { rows: users } = await db.query("SELECT id FROM users");
    const userIds = new Set(users.map((u) => u.id));
    // Ersteller, deren Konto inzwischen gelöscht ist, werden leer gelassen.
    const events = data.events.map((e) => ({ ...e, created_by: userIds.has(e.created_by) ? e.created_by : null }));

    await db.query("DELETE FROM events");
    await db.query("DELETE FROM event_types");
    await db.query("DELETE FROM pros");
    await db.query("INSERT INTO pros SELECT * FROM jsonb_populate_recordset(NULL::pros, $1)", [JSON.stringify(data.pros)]);
    await db.query("INSERT INTO event_types SELECT * FROM jsonb_populate_recordset(NULL::event_types, $1)", [JSON.stringify(data.event_types)]);
    await db.query("INSERT INTO events SELECT * FROM jsonb_populate_recordset(NULL::events, $1)", [JSON.stringify(events)]);
    for (const table of ["pros", "event_types", "events"]) {
      await db.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), coalesce((SELECT max(id) FROM ${table}), 0) + 1, false)`
      );
    }
    const when = new Date(rows[0].created_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" });
    await record(actor, `Version #${versionId} wiederhergestellt (Stand ${when})`, db);
    await db.query("COMMIT");
    return true;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

// Middleware: speichert nach einer erfolgreichen Antwort eine Version.
// describe(req, body) liefert die Beschreibung (darf async sein).
function versioned(describe) {
  return (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 300) {
        res.once("finish", async () => {
          try {
            await record(req.session?.name || "Unbekannt", await describe(req, body));
          } catch (err) {
            console.error("Version konnte nicht gespeichert werden:", err);
          }
        });
      }
      return json(body);
    };
    next();
  };
}

module.exports = { migrate, record, list, restore, versioned };
