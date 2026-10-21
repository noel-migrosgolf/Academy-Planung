// Pläne: Jeder Benutzer hat eigene Pläne und kann sie mit anderen teilen (ansehen oder bearbeiten).
// Termine, Regeln, Verlauf und KI-Chats gehören zu einem Plan; Pros und Event-Typen sind gemeinsam.
// Admins (und der API-Schlüssel) sehen und bearbeiten alle Pläne.
// Der aktuelle Plan kommt mit jeder Anfrage im Header «X-Plan-Id»; ohne Header gilt der erste
// eigene Plan (Admins: der älteste Plan).

const express = require("express");
const { pool } = require("./db");
const auth = require("./auth");
const history = require("./history");

const isAdmin = (session) => ["admin", "api"].includes(session?.role);

// Alle Pläne, die die Sitzung sehen darf, mit Rolle
async function accessible(session) {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.owner_id, coalesce(u.name, 'Administrator') AS owner_name, p.created_at,
            (p.owner_id IS NOT DISTINCT FROM $1::int) AS is_owner, s.can_edit AS shared_edit,
            (SELECT count(*)::int FROM events e WHERE e.plan_id = p.id) AS events
       FROM plans p
       LEFT JOIN users u ON u.id = p.owner_id
       LEFT JOIN plan_shares s ON s.plan_id = p.id AND s.user_id = $1::int
      WHERE $2 OR p.owner_id = $1::int OR s.user_id IS NOT NULL
      ORDER BY (p.owner_id IS NOT DISTINCT FROM $1::int) DESC, p.id`,
    [session.id ?? null, isAdmin(session)]
  );
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    owner: p.owner_name,
    is_owner: p.is_owner && session.id !== undefined,
    can_edit: isAdmin(session) || p.is_owner || p.shared_edit === true,
    can_manage: isAdmin(session) || (p.is_owner && session.id !== undefined),
    role: p.is_owner && session.id !== undefined ? "Besitzer" : p.shared_edit === true || isAdmin(session) ? "bearbeiten" : "ansehen",
    events: p.events,
  }));
}

// Middleware: req.plan = { id, name, can_edit, can_manage }
async function withPlan(req, res, next) {
  try {
    const list = await accessible(req.session);
    const wanted = Number.parseInt(req.get("X-Plan-Id") || req.query.plan, 10);
    const plan = Number.isInteger(wanted)
      ? list.find((p) => p.id === wanted)
      : (isAdmin(req.session) ? [...list].sort((a, b) => a.id - b.id)[0] : list[0]);
    if (!plan) {
      return res.status(Number.isInteger(wanted) ? 403 : 404).json({
        error: Number.isInteger(wanted) ? "Kein Zugriff auf diesen Plan." : "Es gibt noch keinen Plan. Bitte zuerst einen Plan anlegen.",
      });
    }
    req.plan = plan;
    next();
  } catch (err) {
    next(err);
  }
}

function requireEdit(req, res, next) {
  if (!req.plan?.can_edit) return res.status(403).json({ error: "Dieser Plan ist für dich nur zum Ansehen freigegeben." });
  next();
}

// --- Routen ---

const router = express.Router();
router.use(auth.requireLogin);

router.get("/", async (req, res) => {
  res.json({ plans: await accessible(req.session) });
});

// { name, copy_from? } – copy_from übernimmt Termine und Regeln eines Plans, den man sehen darf
router.post("/", async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: "Bitte einen Namen für den Plan eingeben." });
  const copyFrom = Number.parseInt(req.body.copy_from, 10);
  if (Number.isInteger(copyFrom) && !(await accessible(req.session)).some((p) => p.id === copyFrom)) {
    return res.status(403).json({ error: "Kein Zugriff auf den Plan, der kopiert werden soll." });
  }
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query("INSERT INTO plans (name, owner_id) VALUES ($1, $2) RETURNING id", [name, req.session.id ?? null]);
    const planId = rows[0].id;
    if (Number.isInteger(copyFrom)) {
      // Serien bekommen im neuen Plan eigene Serien-IDs
      await db.query(
        `INSERT INTO events (plan_id, type_id, pro_id, date, start_min, end_min, notiz, series_id, series_index, created_by)
         SELECT $1, type_id, pro_id, date, start_min, end_min, notiz,
                CASE WHEN series_id IS NULL THEN NULL ELSE md5(series_id || '-' || $1::int::text) END, series_index, $3
           FROM events WHERE plan_id = $2`,
        [planId, copyFrom, req.session.id ?? null]
      );
      await db.query(
        `INSERT INTO rules (plan_id, art, type_id, type_ids, von, bis, operator, stunden, prozent, wochentage, aktiv, notiz)
         SELECT $1, art, type_id, type_ids, von, bis, operator, stunden, prozent, wochentage, aktiv, notiz
           FROM rules WHERE plan_id = $2`,
        [planId, copyFrom]
      );
    }
    await db.query("COMMIT");
    await history.record(planId, req.session.name, Number.isInteger(copyFrom) ? "Plan als Kopie angelegt" : "Plan angelegt");
    res.status(201).json({ plan: (await accessible(req.session)).find((p) => p.id === planId) });
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
});

async function managed(req, res) {
  const plan = (await accessible(req.session)).find((p) => p.id === Number.parseInt(req.params.id, 10));
  if (!plan) {
    res.status(404).json({ error: "Plan nicht gefunden." });
    return null;
  }
  if (!plan.can_manage) {
    res.status(403).json({ error: "Nur der Besitzer oder ein Admin kann das." });
    return null;
  }
  return plan;
}

router.put("/:id", async (req, res) => {
  const plan = await managed(req, res);
  if (!plan) return;
  const name = String(req.body.name || "").trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: "Bitte einen Namen eingeben." });
  await pool.query("UPDATE plans SET name = $1 WHERE id = $2", [name, plan.id]);
  res.json({ ok: true });
});

router.delete("/:id", async (req, res) => {
  const plan = await managed(req, res);
  if (!plan) return;
  // Termine, Regeln und Freigaben werden mitgelöscht (ON DELETE CASCADE), ebenso Verlauf und KI-Chats.
  await pool.query("DELETE FROM plans WHERE id = $1", [plan.id]);
  res.json({ ok: true });
});

router.get("/:id/shares", async (req, res) => {
  const plan = await managed(req, res);
  if (!plan) return;
  const { rows } = await pool.query(
    `SELECT u.id, u.name, s.can_edit FROM plan_shares s JOIN users u ON u.id = s.user_id WHERE s.plan_id = $1 ORDER BY u.name`,
    [plan.id]
  );
  res.json({ shares: rows });
});

// { user_id, access: "ansehen" | "bearbeiten" | "keiner" }
router.put("/:id/shares", async (req, res) => {
  const plan = await managed(req, res);
  if (!plan) return;
  const userId = Number.parseInt(req.body.user_id, 10) || 0;
  const { rows: owner } = await pool.query("SELECT owner_id FROM plans WHERE id = $1", [plan.id]);
  if (owner[0].owner_id === userId) return res.status(400).json({ error: "Der Besitzer hat immer vollen Zugriff." });
  if (req.body.access === "keiner") {
    await pool.query("DELETE FROM plan_shares WHERE plan_id = $1 AND user_id = $2", [plan.id, userId]);
  } else {
    try {
      await pool.query(
        `INSERT INTO plan_shares (plan_id, user_id, can_edit) VALUES ($1, $2, $3)
         ON CONFLICT (plan_id, user_id) DO UPDATE SET can_edit = $3`,
        [plan.id, userId, req.body.access === "bearbeiten"]
      );
    } catch (err) {
      if (err.code === "23503") return res.status(404).json({ error: "Benutzer nicht gefunden." });
      throw err;
    }
  }
  res.json({ ok: true });
});

module.exports = { router, withPlan, requireEdit, accessible };
