// Versionsverlauf der Zuweisungen: Nach jeder erfolgreichen Änderung an den Events
// (welcher Pro wann welchen Kurs hat) wird der Stand aller Events als Version gespeichert.
// Eine Version lässt sich wiederherstellen; das ist selbst wieder eine Version.
// Pros, Event-Typen und Benutzerkonten sind bewusst ausgenommen (werden manuell gepflegt).

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
  // Ältere Versionen enthielten auch Pros und Event-Typen; sie werden einmalig gelöscht.
  await pool.query("DELETE FROM versions WHERE data ? 'pros'");
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM versions");
  if (rows[0].n === 0) await record("System", "Ausgangsstand");
}

async function snapshot(db) {
  const { rows } = await db.query("SELECT coalesce(jsonb_agg(e ORDER BY e.id), '[]') AS events FROM events e");
  return rows[0];
}

async function record(actor, description, db = pool) {
  const data = await snapshot(db);
  const { rows } = await db.query(
    "INSERT INTO versions (actor, description, data) VALUES ($1, $2, $3) RETURNING id",
    [actor, description, data]
  );
  await db.query(
    "DELETE FROM versions WHERE id NOT IN (SELECT id FROM versions ORDER BY id DESC LIMIT $1)",
    [KEEP_VERSIONS]
  );
  return rows[0].id;
}

async function latestId(db = pool) {
  const { rows } = await db.query("SELECT max(id) AS id FROM versions");
  return rows[0].id;
}

// Entsprechen die aktuellen Daten genau dem Stand dieser Version?
async function matchesCurrent(versionId) {
  const current = await snapshot(pool);
  const { rows } = await pool.query(
    "SELECT data->'events' = $2::jsonb AS same FROM versions WHERE id = $1",
    [versionId, JSON.stringify(current.events)]
  );
  return rows[0]?.same === true;
}

async function list() {
  const { rows } = await pool.query(`
    SELECT id, created_at, actor, description, jsonb_array_length(data->'events') AS events
      FROM versions ORDER BY id DESC
  `);
  return rows;
}

// Setzt die Events auf den Stand der Version zurück. Pros und Event-Typen bleiben unverändert;
// Events, deren Pro oder Typ es nicht mehr gibt, werden ausgelassen.
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
    const ids = async (table) => new Set((await db.query(`SELECT id FROM ${table}`)).rows.map((r) => r.id));
    const [userIds, proIds, typeIds] = [await ids("users"), await ids("pros"), await ids("event_types")];
    const events = data.events
      .filter((e) => proIds.has(e.pro_id) && typeIds.has(e.type_id))
      // Ersteller, deren Konto inzwischen gelöscht ist, werden leer gelassen.
      .map((e) => ({ ...e, created_by: userIds.has(e.created_by) ? e.created_by : null }));
    const skipped = data.events.length - events.length;

    // Die IDs stammen alle aus der Event-Sequenz, die Sequenz muss daher nicht angepasst werden.
    await db.query("DELETE FROM events");
    await db.query("INSERT INTO events SELECT * FROM jsonb_populate_recordset(NULL::events, $1)", [JSON.stringify(events)]);
    const when = new Date(rows[0].created_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" });
    const note = skipped ? `, ${skipped} Events ausgelassen (Pro oder Typ gelöscht)` : "";
    const newId = await record(actor, `Version #${versionId} wiederhergestellt (Stand ${when}${note})`, db);
    await db.query("COMMIT");
    return newId;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

// Middleware: speichert nach einer erfolgreichen Antwort eine Version.
// describe(req, body) liefert die Beschreibung (darf async sein); null = keine Version (z. B. Probelauf).
function versioned(describe) {
  return (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 300) {
        res.once("finish", async () => {
          try {
            const description = await describe(req, body);
            if (description !== null) await record(req.session?.name || "Unbekannt", description);
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

module.exports = { migrate, record, latestId, matchesCurrent, list, restore, versioned };
