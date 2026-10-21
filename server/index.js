const path = require("path");
const express = require("express");
const { pool, migrate } = require("./db");
const auth = require("./auth");
const prosData = require("./pros");

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

api.post("/pros", auth.requireAdmin, (req, res) =>
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

api.put("/pros/:id", auth.requireAdmin, (req, res) =>
  savePro(res, () => {
    const pro = prosData.normalize(req.body);
    const sets = prosData.COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(", ");
    return pool.query(
      `UPDATE pros SET ${sets} WHERE id = $${prosData.COLUMNS.length + 1} RETURNING ${PRO_FIELDS}`,
      [...prosData.values(pro), Number.parseInt(req.params.id, 10) || 0]
    );
  })
);

api.delete("/pros/:id", auth.requireAdmin, async (req, res) => {
  await pool.query("DELETE FROM pros WHERE id = $1", [Number.parseInt(req.params.id, 10) || 0]);
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
  .then(() => app.listen(port, () => console.log(`Academy Planung läuft auf Port ${port}`)))
  .catch((err) => {
    console.error("Datenbank-Migration fehlgeschlagen:", err);
    process.exit(1);
  });
