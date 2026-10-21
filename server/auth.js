const crypto = require("crypto");
const { promisify } = require("util");
const { pool } = require("./db");

const scrypt = promisify(crypto.scrypt);
const COOKIE_NAME = "academy_session";
const SESSION_DAYS = 7;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = stored.split(":");
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, "hex"));
}

function verifyAdminPassword(password) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const a = crypto.createHash("sha256").update(password).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function tokenMatches(token, expected) {
  if (!expected || !token) return false;
  const a = crypto.createHash("sha256").update(String(token)).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// Export-Zugang ohne Anmeldung: Header «X-Export-Token» muss EXPORT_TOKEN entsprechen.
function verifyExportToken(token) {
  return tokenMatches(token, process.env.EXPORT_TOKEN);
}

// Admins (angemeldet), der API-Schlüssel oder ein gültiger Export-Token
function requireAdminOrExportToken(req, res, next) {
  if (["admin", "api"].includes(req.session?.role) || verifyExportToken(req.get("x-export-token"))) return next();
  res.status(403).json({ error: "Keine Berechtigung." });
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  };
}

async function createSession(res, { userId = null, role }) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    "INSERT INTO sessions (token_hash, user_id, role, expires_at) VALUES ($1, $2, $3, $4)",
    [sha256(token), userId, role, expires]
  );
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), expires });
}

async function destroySession(req, res) {
  const token = readCookie(req, COOKIE_NAME);
  if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

// Hängt die aktuelle Sitzung als req.session an (oder null).
async function loadSession(req, res, next) {
  req.session = null;
  // Datenpflege über die API (Header «X-Api-Token» = API_TOKEN): eigene Rolle «api»,
  // darf Pros, Event-Typen, Events und den Verlauf bearbeiten, aber keine Benutzerkonten.
  if (tokenMatches(req.get("x-api-token"), process.env.API_TOKEN)) {
    req.session = { role: "api", name: "Claude (API)", username: "api" };
    return next();
  }
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return next();
  try {
    const { rows } = await pool.query(
      `SELECT s.role, u.id, u.name, u.username, u.is_admin
         FROM sessions s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)]
    );
    const row = rows[0];
    if (row && row.role === "admin") {
      req.session = { role: "admin", name: "Administrator", username: "admin" };
    } else if (row && row.id) {
      // Admin-Rechte werden bei jeder Anfrage aus dem Benutzerkonto gelesen,
      // damit Änderungen sofort wirken.
      req.session = { role: row.is_admin ? "admin" : "user", id: row.id, name: row.name, username: row.username };
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireLogin(req, res, next) {
  if (!req.session) return res.status(401).json({ error: "Nicht angemeldet." });
  next();
}

function requireAdmin(req, res, next) {
  if (req.session?.role !== "admin") return res.status(403).json({ error: "Keine Berechtigung." });
  next();
}

// Admins oder der API-Schlüssel – nur für Daten (Pros, Event-Typen, Events, Verlauf)
function requireDataAdmin(req, res, next) {
  if (!["admin", "api"].includes(req.session?.role)) return res.status(403).json({ error: "Keine Berechtigung." });
  next();
}

// Einfache Begrenzung der Login-Versuche pro IP (im Speicher).
function loginRateLimit({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const attempts = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const entry = attempts.get(req.ip);
    if (!entry || entry.reset < now) {
      attempts.set(req.ip, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++entry.count > max) {
      return res.status(429).json({ error: "Zu viele Versuche. Bitte später erneut probieren." });
    }
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyAdminPassword,
  createSession,
  destroySession,
  loadSession,
  requireLogin,
  requireAdmin,
  requireDataAdmin,
  requireAdminOrExportToken,
  loginRateLimit,
};
