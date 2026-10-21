// Versionsverlauf der Zuweisungen, je Plan: Nach jeder erfolgreichen Änderung an den Events eines Plans
// (welcher Pro wann welchen Kurs hat) wird der Stand aller Events dieses Plans als Version gespeichert.
// Eine Version lässt sich wiederherstellen; das ist selbst wieder eine Version.
// Pros, Event-Typen und Benutzerkonten sind bewusst ausgenommen (werden manuell gepflegt).

const { pool } = require("./db");

const KEEP_VERSIONS = 1000; // je Plan

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS versions (
      id          SERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor       TEXT NOT NULL,
      description TEXT NOT NULL,
      data        JSONB NOT NULL
    );
    ALTER TABLE versions ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES plans(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS versions_plan_idx ON versions (plan_id, id DESC);
  `);
  // Ältere Versionen enthielten auch Pros und Event-Typen; sie werden einmalig gelöscht.
  await pool.query("DELETE FROM versions WHERE data ? 'pros'");
  // Versionen aus der Zeit vor den Plänen gehören zum ältesten Plan (Hauptplan).
  await pool.query("UPDATE versions SET plan_id = (SELECT min(id) FROM plans) WHERE plan_id IS NULL");
  const { rows } = await pool.query("SELECT id FROM plans p WHERE NOT EXISTS (SELECT 1 FROM versions v WHERE v.plan_id = p.id)");
  for (const plan of rows) await record(plan.id, "System", "Ausgangsstand");
}

async function snapshot(db, planId) {
  const { rows } = await db.query(
    "SELECT coalesce(jsonb_agg(e ORDER BY e.id), '[]') AS events FROM events e WHERE e.plan_id = $1",
    [planId]
  );
  return rows[0];
}

async function record(planId, actor, description, db = pool) {
  const data = await snapshot(db, planId);
  const { rows } = await db.query(
    "INSERT INTO versions (plan_id, actor, description, data) VALUES ($1, $2, $3, $4) RETURNING id",
    [planId, actor, description, data]
  );
  await db.query(
    `DELETE FROM versions WHERE plan_id = $1
        AND id NOT IN (SELECT id FROM versions WHERE plan_id = $1 ORDER BY id DESC LIMIT $2)`,
    [planId, KEEP_VERSIONS]
  );
  return rows[0].id;
}

async function latestId(planId, db = pool) {
  const { rows } = await db.query("SELECT max(id) AS id FROM versions WHERE plan_id = $1", [planId]);
  return rows[0].id;
}

// Entsprechen die aktuellen Events des Plans genau dem Stand dieser Version?
async function matchesCurrent(planId, versionId) {
  const current = await snapshot(pool, planId);
  const { rows } = await pool.query(
    "SELECT data->'events' = $3::jsonb AS same FROM versions WHERE id = $1 AND plan_id = $2",
    [versionId, planId, JSON.stringify(current.events)]
  );
  return rows[0]?.same === true;
}

async function list(planId) {
  const { rows } = await pool.query(
    `SELECT id, created_at, actor, description, jsonb_array_length(data->'events') AS events
       FROM versions WHERE plan_id = $1 ORDER BY id DESC`,
    [planId]
  );
  return rows;
}

// Setzt die Events des Plans auf den Stand der Version zurück. Pros und Event-Typen bleiben unverändert;
// Events, deren Pro oder Typ es nicht mehr gibt, werden ausgelassen.
async function restore(planId, versionId, actor) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query("SELECT id, created_at, data FROM versions WHERE id = $1 AND plan_id = $2", [versionId, planId]);
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
      .map((e) => ({ ...e, plan_id: planId, created_by: userIds.has(e.created_by) ? e.created_by : null }));
    const skipped = data.events.length - events.length;

    // Die IDs stammen alle aus der Event-Sequenz, die Sequenz muss daher nicht angepasst werden.
    await db.query("DELETE FROM events WHERE plan_id = $1", [planId]);
    await db.query("INSERT INTO events SELECT * FROM jsonb_populate_recordset(NULL::events, $1)", [JSON.stringify(events)]);
    const when = new Date(rows[0].created_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" });
    const note = skipped ? `, ${skipped} Events ausgelassen (Pro oder Typ gelöscht)` : "";
    const newId = await record(planId, actor, `Version #${versionId} wiederhergestellt (Stand ${when}${note})`, db);
    await db.query("COMMIT");
    return newId;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

// Middleware: speichert nach einer erfolgreichen Antwort eine Version des aktuellen Plans (req.plan).
// describe(req, body) liefert die Beschreibung (darf async sein); null = keine Version (z. B. Probelauf).
function versioned(describe) {
  return (req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 300 && req.plan) {
        res.once("finish", async () => {
          try {
            const description = await describe(req, body);
            if (description !== null) await record(req.plan.id, req.session?.name || "Unbekannt", description);
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
