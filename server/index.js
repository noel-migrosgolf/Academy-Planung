const path = require("path");
const express = require("express");
const { pool, migrate } = require("./db");
const auth = require("./auth");
const prosData = require("./pros");
const eventsData = require("./events");
const history = require("./history");
const { versioned } = history;

const app = express();
app.set("trust proxy", 1); // Render sitzt vor der App
app.use(express.json());
app.use((req, res, next) => {
  req.body ??= {};
  next();
});
app.use(auth.loadSession);

const api = express.Router();
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

api.post("/pros", auth.requireDataAdmin, versioned((req, b) => `Pro «${b.pro.name}» angelegt`), (req, res) =>
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

api.put("/pros/:id", auth.requireDataAdmin, versioned((req, b) => `Pro «${b.pro.name}» geändert`), (req, res) =>
  savePro(res, () => {
    const pro = prosData.normalize(req.body);
    const sets = prosData.COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(", ");
    return pool.query(
      `UPDATE pros SET ${sets} WHERE id = $${prosData.COLUMNS.length + 1} RETURNING ${PRO_FIELDS}`,
      [...prosData.values(pro), Number.parseInt(req.params.id, 10) || 0]
    );
  })
);

api.delete("/pros/:id", auth.requireDataAdmin, versioned((req, b) => `Pro «${b.pro?.name ?? "?"}» gelöscht`), async (req, res) => {
  const { rows } = await pool.query("DELETE FROM pros WHERE id = $1 RETURNING id, name", [Number.parseInt(req.params.id, 10) || 0]);
  if (!rows[0]) return res.status(404).json({ error: "Pro nicht gefunden." });
  res.json({ ok: true, pro: rows[0] });
});

// --- Event-Typen (Vorlagen, nur Admins bearbeiten) ---

const TYPE_FIELDS = `id, ${eventsData.TYPE_COLUMNS.join(", ")}`;

async function loadType(db, typeId) {
  const { rows } = await db.query(`SELECT ${TYPE_FIELDS} FROM event_types WHERE id = $1`, [typeId]);
  if (!rows[0]) throw new eventsData.ValidationError("Event-Typ existiert nicht.");
  return rows[0];
}

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
    throw err;
  }
}

api.post("/event-types", auth.requireDataAdmin, versioned((req, b) => `Event-Typ «${b.type.name}» angelegt`), (req, res) =>
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

api.put("/event-types/:id", auth.requireDataAdmin, versioned((req, b) => `Event-Typ «${b.type.name}» geändert`), (req, res) =>
  saveType(res, async () => {
    const t = eventsData.normalizeType(req.body);
    const cols = eventsData.TYPE_COLUMNS;
    const typeId = Number.parseInt(req.params.id, 10) || 0;
    const result = await pool.query(
      `UPDATE event_types SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}
        WHERE id = $${cols.length + 1} RETURNING ${TYPE_FIELDS}`,
      [...eventsData.typeValues(t), typeId]
    );
    // Bereits geplante Events übernehmen eine geänderte feste Zeit bzw. Brutto-Dauer.
    if (result.rows[0]) await pool.query(eventsData.SYNC_FIXED_EVENTS_SQL, [typeId]);
    return result;
  })
);

api.delete("/event-types/:id", auth.requireDataAdmin, versioned((req, b) => `Event-Typ «${b.type?.name ?? "?"}» gelöscht`), async (req, res) => {
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

const EVENT_FIELDS =
  "id, type_id, pro_id, to_char(date, 'YYYY-MM-DD') AS date, start_min, end_min, notiz, series_id, series_index";

api.get("/events", auth.requireLogin, async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : "0001-01-01";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : "9999-12-31";
  const { rows } = await pool.query(
    `SELECT ${EVENT_FIELDS} FROM events WHERE date BETWEEN $1 AND $2 ORDER BY date, start_min`,
    [from, to]
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

function formatDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

// Überschneidung mit einem anderen Event desselben Pros?
async function assertFree(db, ev, ignoreId, label) {
  const { rows } = await db.query(
    `SELECT 1 FROM events
      WHERE pro_id = $1 AND date = $2 AND start_min < $4 AND end_min > $3 AND id <> $5 LIMIT 1`,
    [ev.pro_id, ev.date, ev.start_min, ev.end_min, ignoreId || 0]
  );
  if (rows.length) {
    const err = new eventsData.ValidationError(`${label}Der Pro hat am ${formatDate(ev.date)} in dieser Zeit bereits ein Event.`);
    err.status = 409;
    throw err;
  }
}

// Kurzbeschreibung für den Verlauf, z. B. «Platzreife Teil 1 A · 09.01.2027 · Yannick (4 Termine)»
async function describeEvents(list) {
  if (!list?.length) return "Event";
  const first = list[0];
  const { rows } = await pool.query(
    "SELECT (SELECT name FROM event_types WHERE id = $1) AS type, (SELECT name FROM pros WHERE id = $2) AS pro",
    [first.type_id, first.pro_id]
  );
  const count = list.length > 1 ? ` (${list.length} Termine)` : "";
  return `${rows[0].type ?? "Event"} · ${formatDate(first.date)} · ${rows[0].pro ?? "?"}${count}`;
}

api.post("/events", auth.requireLogin, versioned(async (req, b) => `Geplant: ${await describeEvents(b.events)}`), (req, res) =>
  inTransaction(res, async (db) => {
    const type = await loadType(db, eventsData.id(req.body.type_id, "Event-Typ"));
    const planned = eventsData.planNew(type, req.body);
    const created = [];
    for (const ev of planned) {
      await assertFree(db, ev, 0, planned.length > 1 ? `Termin ${ev.series_index}: ` : "");
      const { rows } = await db.query(
        `INSERT INTO events (type_id, pro_id, date, start_min, end_min, notiz, series_id, series_index, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${EVENT_FIELDS}`,
        [ev.type_id, ev.pro_id, ev.date, ev.start_min, ev.end_min, ev.notiz, ev.series_id, ev.series_index, req.session.id || null]
      );
      created.push(rows[0]);
    }
    res.status(201).json({ events: created });
  })
);

api.put("/events/:id", auth.requireLogin, versioned(async (req, b) => `Geändert: ${await describeEvents([b.event])}`), (req, res) =>
  inTransaction(res, async (db) => {
    const eventId = Number.parseInt(req.params.id, 10) || 0;
    const { rows } = await db.query(`SELECT ${EVENT_FIELDS} FROM events WHERE id = $1 FOR UPDATE`, [eventId]);
    if (!rows[0]) return res.status(404).json({ error: "Event nicht gefunden." });
    const typeId = rows[0].series_id ? rows[0].type_id : eventsData.id(req.body.type_id, "Event-Typ");
    const ev = eventsData.planUpdate(rows[0], await loadType(db, typeId), req.body);
    await assertFree(db, ev, eventId, "");
    const { rows: updated } = await db.query(
      `UPDATE events SET type_id = $1, pro_id = $2, date = $3, start_min = $4, end_min = $5, notiz = $6
        WHERE id = $7 RETURNING ${EVENT_FIELDS}`,
      [ev.type_id, ev.pro_id, ev.date, ev.start_min, ev.end_min, ev.notiz, eventId]
    );
    res.json({ event: updated[0] });
  })
);

// ?serie=1 löscht alle Termine der Serie
api.delete("/events/:id", auth.requireLogin, versioned(async (req, b) => `Gelöscht: ${await describeEvents(b.deleted)}`), async (req, res) => {
  const eventId = Number.parseInt(req.params.id, 10) || 0;
  const { rows } = req.query.serie
    ? await pool.query(
        `DELETE FROM events WHERE id = $1 OR series_id = (SELECT series_id FROM events WHERE id = $1)
         RETURNING ${EVENT_FIELDS}`,
        [eventId]
      )
    : await pool.query(`DELETE FROM events WHERE id = $1 RETURNING ${EVENT_FIELDS}`, [eventId]);
  res.json({ deleted: rows });
});

// --- Export (nur lesend): alle Daten als JSON, ohne Passwörter und Sitzungen ---

api.get("/export", limitExport, auth.requireAdminOrExportToken, async (req, res) => {
  const [users, pros, types, events] = await Promise.all([
    pool.query("SELECT id, name, username, is_admin, created_at FROM users ORDER BY id"),
    pool.query(`SELECT ${PRO_FIELDS}, sort_order, created_at FROM pros ORDER BY sort_order, id`),
    pool.query(`SELECT ${TYPE_FIELDS}, sort_order, created_at FROM event_types ORDER BY sort_order, id`),
    pool.query(`SELECT ${EVENT_FIELDS}, created_by, created_at FROM events ORDER BY date, start_min, id`),
  ]);
  const stamp = new Date().toISOString();
  res.set("Content-Disposition", `attachment; filename="academy-planung-${stamp.slice(0, 10)}.json"`);
  res.json({
    exported_at: stamp,
    users: users.rows,
    pros: pros.rows,
    event_types: types.rows,
    events: events.rows,
  });
});

// --- Versionsverlauf (Pros, Event-Typen, Events) ---

api.get("/versions", auth.requireDataAdmin, async (req, res) => {
  res.json({ versions: await history.list() });
});

api.post("/versions/:id/restore", auth.requireDataAdmin, async (req, res) => {
  const ok = await history.restore(Number.parseInt(req.params.id, 10) || 0, req.session.name);
  if (!ok) return res.status(404).json({ error: "Version nicht gefunden." });
  res.json({ ok: true });
});

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
  .then(() => app.listen(port, () => console.log(`Academy Planung läuft auf Port ${port}`)))
  .catch((err) => {
    console.error("Datenbank-Migration fehlgeschlagen:", err);
    process.exit(1);
  });
