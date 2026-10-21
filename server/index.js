const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { pool, migrate } = require("./db");
const auth = require("./auth");
const prosData = require("./pros");
const eventsData = require("./events");
const rulesData = require("./rules");
const history = require("./history");
const planning = require("./planning");
const ai = require("./ai");
const plans = require("./plans");
const { versioned } = history;
const { TYPE_FIELDS, EVENT_FIELDS, loadType, assertFree, describeEvents } = planning;

const app = express();
app.set("trust proxy", 1); // Render sitzt vor der App
app.use(express.json());
app.use((req, res, next) => {
  req.body ??= {};
  next();
});
app.use(auth.loadSession);

const api = express.Router();
// Routen eines Plans: ansehen bzw. bearbeiten (aktueller Plan per Header X-Plan-Id, siehe server/plans.js)
const view = [auth.requireLogin, plans.withPlan];
const edit = [auth.requireLogin, plans.withPlan, plans.requireEdit];
const limitLogin = auth.loginRateLimit();
const limitExport = auth.loginRateLimit({ max: 60 });

api.get("/health", (req, res) => res.json({ ok: true }));

api.get("/me", (req, res) => {
  res.json({ user: req.session });
});

// Benutzerauswahl auf der Anmeldeseite (nur Name, ohne Anmeldung abrufbar).
api.get("/auth/users", async (req, res) => {
  const { rows } = await pool.query("SELECT id, name FROM users ORDER BY name");
  res.json({ users: rows });
});

api.post("/login", limitLogin, async (req, res) => {
  const password = String(req.body.password || "");
  const { rows } = req.body.userId !== undefined
    ? await pool.query("SELECT * FROM users WHERE id = $1", [Number.parseInt(req.body.userId, 10) || 0])
    : await pool.query("SELECT * FROM users WHERE username = $1", [String(req.body.username || "").trim().toLowerCase()]);
  const user = rows[0];
  if (!user || !(await auth.verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: "Passwort falsch." });
  }
  await auth.createSession(res, { userId: user.id, role: "user" });
  res.json({ user: { role: user.is_admin ? "admin" : "user", id: user.id, name: user.name, username: user.username } });
});

api.post("/admin/login", limitLogin, async (req, res) => {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).json({ error: "Admin-Zugang ist nicht konfiguriert (ADMIN_PASSWORD fehlt)." });
  }
  if (!auth.verifyAdminPassword(String(req.body.password || ""))) {
    return res.status(401).json({ error: "Admin-Passwort falsch." });
  }
  await auth.createSession(res, { role: "admin" });
  res.json({ user: { role: "admin", name: "Administrator", username: "admin" } });
});

api.post("/logout", async (req, res) => {
  await auth.destroySession(req, res);
  res.json({ ok: true });
});

api.get("/users", auth.requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, username, is_admin, created_at FROM users ORDER BY name"
  );
  res.json({ users: rows });
});

api.post("/users", auth.requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name || !username || !password) {
    return res.status(400).json({ error: "Bitte alle Felder ausfüllen." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Passwort muss mindestens 6 Zeichen lang sein." });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, username, password_hash, is_admin) VALUES ($1, $2, $3, $4)
       RETURNING id, name, username, is_admin, created_at`,
      [name, username, await auth.hashPassword(password), req.body.is_admin === true]
    );
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Benutzername ist bereits vergeben." });
    }
    throw err;
  }
});

api.patch("/users/:id", auth.requireAdmin, async (req, res) => {
  if (typeof req.body.is_admin !== "boolean") {
    return res.status(400).json({ error: "Ungültige Angabe für Admin-Rechte." });
  }
  const { rows } = await pool.query(
    "UPDATE users SET is_admin = $1 WHERE id = $2 RETURNING id, name, username, is_admin, created_at",
    [req.body.is_admin, Number.parseInt(req.params.id, 10) || 0]
  );
  if (!rows[0]) return res.status(404).json({ error: "Benutzer nicht gefunden." });
  res.json({ user: rows[0] });
});

api.delete("/users/:id", auth.requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM users WHERE id = $1", [Number(req.params.id)]);
  res.json({ ok: true });
});

const PRO_FIELDS = `id, ${prosData.COLUMNS.join(", ")}`;

api.get("/pros", auth.requireLogin, async (req, res) => {
  const { rows } = await pool.query(`SELECT ${PRO_FIELDS} FROM pros ORDER BY sort_order, id`);
  res.json({ pros: rows });
});

// Gemeinsame Fehlerbehandlung für Anlegen und Bearbeiten.
async function savePro(res, run) {
  try {
    const { rows } = await run();
    if (!rows[0]) return res.status(404).json({ error: "Pro nicht gefunden." });
    res.json({ pro: rows[0] });
  } catch (err) {
    if (err instanceof prosData.ValidationError) return res.status(400).json({ error: err.message });
    if (err.code === "23505") return res.status(409).json({ error: "Dieses Kürzel ist bereits vergeben." });
    throw err;
  }
}

// Pros und Event-Typen werden manuell gepflegt und nicht im Verlauf gespeichert (nur die Events).
api.post("/pros", auth.requireDataAdmin, (req, res) =>
  savePro(res, () => {
    const pro = prosData.normalize(req.body);
    const params = prosData.COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
    return pool.query(
      `INSERT INTO pros (${prosData.COLUMNS.join(", ")}, sort_order)
       VALUES (${params}, (SELECT coalesce(max(sort_order), 0) + 1 FROM pros))
       RETURNING ${PRO_FIELDS}`,
      prosData.values(pro)
    );
  })
);

api.put("/pros/:id", auth.requireDataAdmin, (req, res) =>
  savePro(res, () => {
    const pro = prosData.normalize(req.body);
    const sets = prosData.COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(", ");
    return pool.query(
      `UPDATE pros SET ${sets} WHERE id = $${prosData.COLUMNS.length + 1} RETURNING ${PRO_FIELDS}`,
      [...prosData.values(pro), Number.parseInt(req.params.id, 10) || 0]
    );
  })
);

// Mit dem Pro werden auch seine Events gelöscht (in allen Plänen); betroffene Pläne erhalten eine Version.
api.delete("/pros/:id", auth.requireDataAdmin, async (req, res) => {
  const proId = Number.parseInt(req.params.id, 10) || 0;
  const { rows: affected } = await pool.query(
    "SELECT plan_id, count(*)::int AS n FROM events WHERE pro_id = $1 GROUP BY plan_id",
    [proId]
  );
  const { rows } = await pool.query("DELETE FROM pros WHERE id = $1 RETURNING id, name", [proId]);
  if (!rows[0]) return res.status(404).json({ error: "Pro nicht gefunden." });
  for (const a of affected) {
    await history.record(a.plan_id, req.session.name, `Pro «${rows[0].name}» gelöscht, ${a.n} Events entfernt`);
  }
  res.json({ ok: true, pro: rows[0], events: affected.reduce((sum, a) => sum + a.n, 0) });
});

// --- Event-Typen (Vorlagen, nur Admins bearbeiten) ---

api.get("/event-types", auth.requireLogin, async (req, res) => {
  const { rows } = await pool.query(`SELECT ${TYPE_FIELDS} FROM event_types ORDER BY sort_order, id`);
  res.json({ types: rows });
});

async function saveType(res, run) {
  try {
    const { rows } = await run();
    if (!rows[0]) return res.status(404).json({ error: "Event-Typ nicht gefunden." });
    res.json({ type: rows[0] });
  } catch (err) {
    if (err instanceof eventsData.ValidationError) return res.status(400).json({ error: err.message });
    if (err.code === "23505") return res.status(409).json({ error: "Diese ID ist bereits vergeben." });
    throw err;
  }
}

api.post("/event-types", auth.requireDataAdmin, (req, res) =>
  saveType(res, () => {
    const t = eventsData.normalizeType(req.body);
    const cols = eventsData.TYPE_COLUMNS;
    return pool.query(
      `INSERT INTO event_types (${cols.join(", ")}, sort_order)
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, (SELECT coalesce(max(sort_order), 0) + 1 FROM event_types))
       RETURNING ${TYPE_FIELDS}`,
      eventsData.typeValues(t)
    );
  })
);

api.put("/event-types/:id", auth.requireDataAdmin, (req, res) =>
  saveType(res, async () => {
    const typeId = Number.parseInt(req.params.id, 10) || 0;
    // Fehlen neuere Felder in der Anfrage (z. B. ältere Seite im Browser-Cache), bleiben sie unverändert.
    const body = { ...req.body };
    const { rows: old } = await pool.query(`SELECT ${TYPE_FIELDS} FROM event_types WHERE id = $1`, [typeId]);
    for (const key of ["einsatzbereich", "einplanbar_von", "einplanbar_bis", "max_stunden"]) {
      if (!(key in body)) body[key] = old[0]?.[key] ?? null;
    }
    const t = eventsData.normalizeType(body);
    const cols = eventsData.TYPE_COLUMNS;
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const result = await db.query(
        `UPDATE event_types SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}
          WHERE id = $${cols.length + 1} RETURNING ${TYPE_FIELDS}`,
        [...eventsData.typeValues(t), typeId]
      );
      // Bereits geplante Events übernehmen eine geänderte feste Zeit bzw. Brutto-Dauer –
      // aber nur, wenn dadurch kein Pro doppelt gebucht wird (in keinem Plan).
      if (result.rows[0]) {
        await db.query(eventsData.SYNC_FIXED_EVENTS_SQL, [typeId]);
        const { rows: clashes } = await db.query(
          `SELECT p.name AS pro, to_char(a.date, 'DD.MM.YYYY') AS datum, pl.name AS plan
             FROM events a
             JOIN events b ON b.plan_id = a.plan_id AND b.pro_id = a.pro_id AND b.date = a.date AND b.id <> a.id
                          AND a.start_min < b.end_min AND b.start_min < a.end_min
             JOIN pros p ON p.id = a.pro_id
             JOIN plans pl ON pl.id = a.plan_id
            WHERE a.type_id = $1
            GROUP BY p.name, a.date, pl.name ORDER BY a.date LIMIT 4`,
          [typeId]
        );
        if (clashes.length) {
          const list = clashes.map((c) => `${c.pro} am ${c.datum} (Plan «${c.plan}»)`).join(", ");
          throw new eventsData.ValidationError(
            `Die neue Zeit würde bestehende Termine überschneiden: ${list}${clashes.length === 4 ? " …" : ""}. Bitte zuerst diese Termine verschieben.`
          );
        }
      }
      await db.query("COMMIT");
      return result;
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  })
);

api.delete("/event-types/:id", auth.requireDataAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("DELETE FROM event_types WHERE id = $1 RETURNING id, name", [Number.parseInt(req.params.id, 10) || 0]);
    if (!rows[0]) return res.status(404).json({ error: "Event-Typ nicht gefunden." });
    res.json({ ok: true, type: rows[0] });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(409).json({ error: "Dieser Typ wird noch von geplanten Events verwendet und kann nicht gelöscht werden." });
    }
    throw err;
  }
});

// --- Events (geplante Einsätze, einzeln oder als Serie) ---

api.get("/events", ...view, async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : "0001-01-01";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : "9999-12-31";
  const { rows } = await pool.query(
    `SELECT ${EVENT_FIELDS} FROM events WHERE plan_id = $3 AND date BETWEEN $1 AND $2 ORDER BY date, start_min`,
    [from, to, req.plan.id]
  );
  res.json({ events: rows });
});

// Führt fn in einer Transaktion aus; Prüf- und Datenfehler werden als Antwort gemeldet.
async function inTransaction(res, fn) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    if (err instanceof eventsData.ValidationError) return res.status(err.status || 400).json({ error: err.message });
    if (err.code === "23503") return res.status(400).json({ error: "Pro oder Event-Typ existiert nicht." });
    throw err;
  } finally {
    db.release();
  }
}

api.post("/events", ...edit, versioned(async (req, b) => `Geplant: ${await describeEvents(b.events)}`), (req, res) =>
  inTransaction(res, async (db) => {
    const type = await loadType(db, eventsData.id(req.body.type_id, "Event-Typ"));
    const planned = eventsData.planNew(type, req.body);
    await planning.assertArea(db, type, planned.map((ev) => ev.pro_id));
    await planning.assertAvailable(db, planned);
    const planId = req.plan.id;
    await planning.assertCapacity(db, planId, type, planned.reduce((sum, ev) => sum + planning.minutesOf(ev, type, "brutto"), 0));
    await planning.assertRules(db, planId, type, planned);
    const created = [];
    for (const ev of planned) {
      await assertFree(db, planId, ev, 0, planned.length > 1 ? `Termin ${ev.series_index}: ` : "");
      const { rows } = await db.query(
        `INSERT INTO events (plan_id, type_id, pro_id, date, start_min, end_min, notiz, series_id, series_index, created_by)
         VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${EVENT_FIELDS}`,
        [ev.type_id, ev.pro_id, ev.date, ev.start_min, ev.end_min, ev.notiz, ev.series_id, ev.series_index, req.session.id || null, planId]
      );
      created.push(rows[0]);
    }
    res.status(201).json({ events: created });
  })
);

api.put("/events/:id", ...edit, versioned(async (req, b) => `Geändert: ${await describeEvents([b.event])}`), (req, res) =>
  inTransaction(res, async (db) => {
    const eventId = Number.parseInt(req.params.id, 10) || 0;
    const planId = req.plan.id;
    const { rows } = await db.query(`SELECT ${EVENT_FIELDS} FROM events WHERE id = $1 AND plan_id = $2 FOR UPDATE`, [eventId, planId]);
    if (!rows[0]) return res.status(404).json({ error: "Event nicht gefunden." });
    const typeId = rows[0].series_id ? rows[0].type_id : eventsData.id(req.body.type_id, "Event-Typ");
    const type = await loadType(db, typeId);
    const ev = eventsData.planUpdate(rows[0], type, req.body);
    await planning.assertArea(db, type, [ev.pro_id]);
    await planning.assertAvailable(db, [ev]);
    const before = type.id === rows[0].type_id ? planning.minutesOf(rows[0], type, "brutto") : 0;
    await planning.assertCapacity(db, planId, type, planning.minutesOf(ev, type, "brutto") - before);
    await planning.assertRules(db, planId, type, [ev], type.id === rows[0].type_id ? [rows[0]] : []);
    await assertFree(db, planId, ev, eventId, "");
    const { rows: updated } = await db.query(
      `UPDATE events SET type_id = $1, pro_id = $2, date = $3, start_min = $4, end_min = $5, notiz = $6
        WHERE id = $7 RETURNING ${EVENT_FIELDS}`,
      [ev.type_id, ev.pro_id, ev.date, ev.start_min, ev.end_min, ev.notiz, eventId]
    );
    res.json({ event: updated[0] });
  })
);

// ?serie=1 löscht alle Termine der Serie
api.delete("/events/:id", ...edit, versioned(async (req, b) => (b.deleted.length ? `Gelöscht: ${await describeEvents(b.deleted)}` : null)), async (req, res) => {
  const eventId = Number.parseInt(req.params.id, 10) || 0;
  const { rows } = req.query.serie
    ? await pool.query(
        `DELETE FROM events WHERE plan_id = $2 AND (id = $1 OR series_id = (SELECT series_id FROM events WHERE id = $1 AND plan_id = $2))
         RETURNING ${EVENT_FIELDS}`,
        [eventId, req.plan.id]
      )
    : await pool.query(`DELETE FROM events WHERE id = $1 AND plan_id = $2 RETURNING ${EVENT_FIELDS}`, [eventId, req.plan.id]);
  const undoToken = rows.length ? offerUndo(req, { deleted: rows }, `Gelöscht: ${await describeEvents(rows)}`) : null;
  res.json({ deleted: rows, undo_token: undoToken });
});

// --- Rückgängig für die Meldung «Rückgängig» (Löschen, Auslasten) ---
// Die betroffenen Termine bleiben 15 Minuten auf dem Server; zurückgenommen wird mit derselben
// konfliktsicheren Logik wie bei der KI (planning.undoChange).
const UNDO_TTL_MS = 15 * 60 * 1000;
const undoStore = new Map(); // Schlüssel → { planId, sessionKey, undo, text, expires }
const sessionKey = (session) => (session.id ? `user:${session.id}` : session.role);

function offerUndo(req, undo, text) {
  const now = Date.now();
  for (const [key, entry] of undoStore) if (entry.expires < now) undoStore.delete(key);
  const token = crypto.randomUUID();
  undoStore.set(token, { planId: req.plan.id, sessionKey: sessionKey(req.session), undo, text, expires: now + UNDO_TTL_MS });
  return token;
}

api.post("/undo/:token", ...edit, async (req, res) => {
  const entry = undoStore.get(req.params.token);
  if (!entry || entry.expires < Date.now() || entry.planId !== req.plan.id || entry.sessionKey !== sessionKey(req.session)) {
    return res.status(404).json({ error: "Rückgängig ist nicht mehr möglich." });
  }
  const result = await planning.undoChange(entry.planId, entry.undo);
  if (result.errors.length) {
    return res.status(409).json({ error: `Rückgängig nicht möglich, nichts geändert: ${result.errors.map((e) => e.fehler).join(" ")}` });
  }
  undoStore.delete(req.params.token);
  await history.record(entry.planId, req.session.name, `Rückgängig: ${entry.text}`);
  res.json({ ok: true, done: result.done });
});

// --- Lesefreundliche Übersicht und Sammel-Aktionen (für API und KI) ---

const isDate = (v) => eventsData.validDate(String(v || ""));

// ?from=YYYY-MM-DD&to=YYYY-MM-DD&pro=Name|Kürzel&format=text
api.get("/overview", ...view, async (req, res) => {
  try {
    const o = await planning.overview(req.plan.id, {
      from: isDate(req.query.from) ? req.query.from : null,
      to: isDate(req.query.to) ? req.query.to : null,
      pro: req.query.pro || null,
    });
    if (req.query.format === "text") return res.type("text/plain").send(planning.overviewText(o, { maxEvents: Infinity }));
    res.json(o);
  } catch (err) {
    if (err instanceof planning.PlanningError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// Gemeinsamer Ablauf: «dry_run: true» prüft nur; ein echter Lauf mit Fehlern ändert nichts (409).
function bulkRoute(run, describe) {
  return [
    ...edit,
    versioned((req, b) => (b.dryRun || b.errors.length ? null : describe(b))),
    async (req, res) => {
      try {
        const result = await run(req);
        res.status(result.errors.length && !result.dryRun ? 409 : 200).json(result);
      } catch (err) {
        if (err instanceof planning.PlanningError) return res.status(400).json({ error: err.message });
        throw err;
      }
    },
  ];
}

api.post("/events/bulk", ...bulkRoute(
  (req) => planning.bulkCreate(req.plan.id, req.body.events, { dryRun: req.body.dry_run === true, userId: req.session.id || null }),
  (b) => `Sammelplanung: ${b.created.length} Termine`
));

api.post("/events/bulk-update", ...bulkRoute(
  (req) => planning.bulkUpdate(req.plan.id, req.body.changes, { dryRun: req.body.dry_run === true }),
  (b) => `Sammeländerung: ${b.updated.length} Termine`
));

api.post("/events/bulk-delete", ...bulkRoute(
  (req) => planning.bulkDelete(req.plan.id, req.body.ids, { serie: req.body.serie === true, dryRun: req.body.dry_run === true }),
  (b) => `Sammellöschung: ${b.deleted.length} Termine`
));

// --- Regeln (Reiter «Regeln», server/rules.js); je Plan, bearbeiten mit Schreibrecht am Plan, nicht im Verlauf ---

api.get("/rules", ...view, async (req, res) => {
  res.json({ rules: await planning.ruleStatus(req.plan.id) });
});

async function saveRule(res, run) {
  try {
    const { rows } = await run();
    if (!rows[0]) return res.status(404).json({ error: "Regel nicht gefunden." });
    res.json({ rule: rows[0] });
  } catch (err) {
    if (err instanceof eventsData.ValidationError) return res.status(400).json({ error: err.message });
    if (err.code === "23503") return res.status(400).json({ error: "Diesen Kurs gibt es nicht." });
    throw err;
  }
}

// Warum ist die Regel (nicht) erfüllt?
api.get("/rules/:id/check", ...view, async (req, res) => {
  try {
    res.json({ lines: await planning.diagnoseRule(req.plan.id, req.params.id) });
  } catch (err) {
    if (err instanceof planning.PlanningError) return res.status(404).json({ error: err.message });
    throw err;
  }
});

api.post("/rules", ...edit, (req, res) =>
  saveRule(res, () => {
    const r = rulesData.normalize(req.body);
    const n = rulesData.COLUMNS.length;
    return pool.query(
      `INSERT INTO rules (plan_id, ${rulesData.COLUMNS.join(", ")})
       VALUES ($${n + 1}, ${rulesData.COLUMNS.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      [...rulesData.values(r), req.plan.id]
    );
  })
);

api.put("/rules/:id", ...edit, (req, res) =>
  saveRule(res, () => {
    const r = rulesData.normalize(req.body);
    const n = rulesData.COLUMNS.length;
    const sets = rulesData.COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(", ");
    return pool.query(`UPDATE rules SET ${sets} WHERE id = $${n + 1} AND plan_id = $${n + 2} RETURNING id`, [
      ...rulesData.values(r),
      Number.parseInt(req.params.id, 10) || 0,
      req.plan.id,
    ]);
  })
);

api.delete("/rules/:id", ...edit, async (req, res) => {
  await pool.query("DELETE FROM rules WHERE id = $1 AND plan_id = $2", [Number.parseInt(req.params.id, 10) || 0, req.plan.id]);
  res.json({ ok: true });
});

// --- Auslasten: Kurse automatisch verteilen, Ziel je Pro (Reiter «Auslasten») ---

// { ziele: [{ pro, prozent }], typen?, von?, bis?, freie_tage_beachten?, dry_run? }
// Admins speichern die Ziele dabei als Soll-Auslastung der Pros.
api.post("/autofill", ...edit,
  versioned((req, b) => (b.dryRun || !b.count ? null : `Auslasten: ${b.summary.length} Pros (${b.count} Termine)`)),
  async (req, res) => {
    const dryRun = req.body.dry_run === true;
    try {
      const r = await planning.autoFill(req.plan.id, req.body, { dryRun, userId: req.session.id || null });
      if (!dryRun && ["admin", "api"].includes(req.session.role)) {
        for (const z of req.body.ziele || []) {
          await pool.query("UPDATE pros SET auslastung_soll_prozent = $1 WHERE id = $2", [Math.round(Number(z.prozent)), Number(z.pro) || 0]);
        }
      }
      res.json({
        dryRun,
        count: r.created.length,
        summary: r.summary,
        regeln: r.regeln,
        created: dryRun ? [] : r.created.map((e) => e.id),
        undo_token: dryRun || !r.created.length ? null : offerUndo(req, { created: r.created }, `Auslasten (${r.created.length} Termine)`),
      });
    } catch (err) {
      if (err instanceof planning.PlanningError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });

// --- Export (nur lesend): alle Daten als JSON, ohne Passwörter und Sitzungen ---

api.get("/export", limitExport, auth.requireAdminOrExportToken, async (req, res) => {
  const [users, plansRows, pros, types, events, rulesRows] = await Promise.all([
    pool.query("SELECT id, name, username, is_admin, created_at FROM users ORDER BY id"),
    pool.query("SELECT id, name, owner_id, created_at FROM plans ORDER BY id"),
    pool.query(`SELECT ${PRO_FIELDS}, sort_order, created_at FROM pros ORDER BY sort_order, id`),
    pool.query(`SELECT ${TYPE_FIELDS}, sort_order, created_at FROM event_types ORDER BY sort_order, id`),
    pool.query(`SELECT plan_id, ${EVENT_FIELDS}, created_by, created_at FROM events ORDER BY plan_id, date, start_min, id`),
    pool.query("SELECT * FROM rules ORDER BY plan_id, id"),
  ]);
  const stamp = new Date().toISOString();
  res.set("Content-Disposition", `attachment; filename="academy-planung-${stamp.slice(0, 10)}.json"`);
  res.json({
    exported_at: stamp,
    users: users.rows,
    plans: plansRows.rows,
    pros: pros.rows,
    event_types: types.rows,
    events: events.rows,
    rules: rulesRows.rows,
  });
});

// --- Versionsverlauf (nur Events, je Plan) ---

api.get("/versions", ...view, async (req, res) => {
  res.json({ versions: await history.list(req.plan.id) });
});

api.post("/versions/:id/restore", ...edit, async (req, res) => {
  const ok = await history.restore(req.plan.id, Number.parseInt(req.params.id, 10) || 0, req.session.name);
  if (!ok) return res.status(404).json({ error: "Version nicht gefunden." });
  res.json({ ok: true });
});

api.use("/plans", plans.router);
api.use("/ai", ai.router);

app.use("/api", api);
app.use("/api", (req, res) => res.status(404).json({ error: "Nicht gefunden." }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Serverfehler. Bitte später erneut versuchen." });
});

const port = process.env.PORT || 3000;

migrate()
  .then(() => history.migrate())
  .then(() => ai.migrate())
  .then(() => app.listen(port, () => console.log(`Academy Planung läuft auf Port ${port}`)))
  .catch((err) => {
    console.error("Datenbank-Migration fehlgeschlagen:", err);
    process.exit(1);
  });
