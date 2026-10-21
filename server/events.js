// Event-Typen (Vorlagen) und geplante Events: Prüfung der Eingaben und Terminberechnung.
//
// Stunden-Berechnung je Typ:
//   faktor   – Brutto/Netto in Minuten pro 30 min geplanter Zeit
//              (Einzelstunde 30/25 → 1 h geplant = 1 h brutto = 50 min netto)
//   pauschal – feste Brutto/Netto-Minuten pro Termin
//              (Platzreife Teil 1 A: 3 h brutto, 2.5 h netto pro Termin)
//
// Optional je Typ:
//   fixed_start_min/fixed_end_min – feste Uhrzeit (z. B. 10:00–12:30)
//   first_weekday                 – erster Termin nur an diesem Wochentag (0 = Mo … 6 = So)
//   series_offsets                – Serie: Tage nach dem ersten Termin, z. B. [0, 1, 7, 8]
//                                   = Sa, darauf folgender So, nächster Sa, nächster So
//   series_times                  – Serie: eigene Zeit je Termin, z. B. [[840, 990], [600, 750], [840, 990]]
//                                   (dann sind auch mehrere Termine am selben Tag möglich)

const crypto = require("crypto");

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

const SEED_TYPES = [
  { name: "Einzelstunde", calc: "faktor", brutto_min: 30, netto_min: 25, color: "#6a8fd8" },
];

// Neuer Typ, der einmalig beim Ausbau auf Serien angelegt wird.
const SEED_SERIES_TYPES = [
  {
    name: "Platzreife Teil 1 A",
    calc: "pauschal",
    brutto_min: 30,
    netto_min: 30,
    brutto_fix_min: 180,
    netto_fix_min: 150,
    fixed_start_min: 10 * 60,
    fixed_end_min: 12 * 60 + 30,
    first_weekday: 5,
    series_offsets: [0, 1, 7, 8],
    color: "#1baf7a",
  },
];

const TYPE_COLUMNS = [
  "code", "name", "color", "calc", "brutto_min", "netto_min", "brutto_fix_min", "netto_fix_min",
  "fixed_start_min", "fixed_end_min", "first_weekday", "series_offsets", "series_times",
];

class ValidationError extends Error {}

function int(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${label} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return n;
}

const empty = (v) => v === null || v === undefined || v === "";

// "HH:MM" oder Minuten seit Mitternacht → Minuten
function minutes(value, label) {
  if (typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value)) {
    const [h, m] = value.split(":").map(Number);
    value = h * 60 + m;
  }
  const n = int(value, label, 0, 24 * 60);
  if (n % 5 !== 0) throw new ValidationError(`${label}: bitte in 5-Minuten-Schritten.`);
  return n;
}

function normalizeType(body) {
  const name = String(body.name || "").trim();
  if (!name) throw new ValidationError("Bitte einen Namen eingeben.");
  // ID: frei wählbar (z. B. «PR2A»), eindeutig, von Admins änderbar
  const code = String(body.code ?? "").trim() || null;
  if (code && (code.length > 30 || /[|\s]/.test(code))) {
    throw new ValidationError("ID: höchstens 30 Zeichen, ohne Leerzeichen und «|».");
  }
  const color = String(body.color || "#6a8fd8");
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new ValidationError("Ungültige Farbe.");

  const calc = body.calc === "pauschal" ? "pauschal" : "faktor";
  const t = { code, name, color, calc, brutto_min: 30, netto_min: 30, brutto_fix_min: null, netto_fix_min: null };
  if (calc === "faktor") {
    t.brutto_min = int(body.brutto_min, "Brutto (Minuten pro 30 min)", 0, 30);
    t.netto_min = int(body.netto_min, "Netto (Minuten pro 30 min)", 0, 30);
    if (t.netto_min > t.brutto_min) throw new ValidationError("Netto darf nicht grösser als Brutto sein.");
  } else {
    t.brutto_fix_min = int(body.brutto_fix_min, "Brutto pro Termin (Minuten)", 0, 24 * 60);
    t.netto_fix_min = int(body.netto_fix_min, "Netto pro Termin (Minuten)", 0, 24 * 60);
    if (t.netto_fix_min > t.brutto_fix_min) throw new ValidationError("Netto darf nicht grösser als Brutto sein.");
  }

  if (empty(body.fixed_start_min) !== empty(body.fixed_end_min)) {
    throw new ValidationError("Feste Zeit: bitte Beginn und Ende angeben (oder beides leer lassen).");
  }
  t.fixed_start_min = empty(body.fixed_start_min) ? null : minutes(body.fixed_start_min, "Feste Zeit Beginn");
  t.fixed_end_min = empty(body.fixed_end_min) ? null : minutes(body.fixed_end_min, "Feste Zeit Ende");
  if (t.fixed_start_min !== null && t.fixed_end_min <= t.fixed_start_min) {
    throw new ValidationError("Feste Zeit: Das Ende muss nach dem Beginn liegen.");
  }

  t.first_weekday = empty(body.first_weekday) ? null : int(body.first_weekday, "Wochentag", 0, 6);

  const offsets = Array.isArray(body.series_offsets) && body.series_offsets.length ? body.series_offsets : [0];
  t.series_offsets = offsets.map((o) => int(o, "Abstand der Termine (Tage)", 0, 365));
  if (t.series_offsets[0] !== 0) throw new ValidationError("Der erste Termin hat immer den Abstand 0.");
  if (t.series_offsets.length > 20) throw new ValidationError("Höchstens 20 Termine pro Serie.");

  t.series_times = seriesTimes(body.series_times, t.series_offsets.length);
  if (t.series_times) [t.fixed_start_min, t.fixed_end_min] = t.series_times[0];

  // Mehrere Termine am selben Tag nur mit eigener Zeit je Termin
  for (let i = 1; i < t.series_offsets.length; i++) {
    const same = t.series_offsets[i] === t.series_offsets[i - 1];
    if (t.series_offsets[i] < t.series_offsets[i - 1] || (same && !t.series_times)) {
      throw new ValidationError("Die Abstände der Termine müssen aufsteigend sein (gleicher Tag nur mit eigener Zeit je Termin).");
    }
    if (same && t.series_times[i][0] < t.series_times[i - 1][1]) {
      throw new ValidationError(`Termin ${i + 1} liegt am selben Tag wie Termin ${i} und muss danach beginnen.`);
    }
  }
  return t;
}

// Zeit je Termin: [[Beginn, Ende], …] oder ["HH:MM-HH:MM", …]; leer = keine
function seriesTimes(value, count) {
  if (empty(value) || (Array.isArray(value) && !value.length)) return null;
  if (!Array.isArray(value)) throw new ValidationError("Zeit pro Termin: ungültige Angabe.");
  if (count < 2) throw new ValidationError("Zeit pro Termin gibt es nur bei Serien mit mehreren Terminen.");
  if (value.length !== count) {
    throw new ValidationError(`Zeit pro Termin: bitte genau ${count} Zeiten angeben (eine pro Termin).`);
  }
  return value.map((v, i) => {
    const pair = typeof v === "string" ? v.split(/\s*[-–]\s*/) : v;
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new ValidationError(`Zeit pro Termin ${i + 1}: bitte als «HH:MM-HH:MM» angeben.`);
    }
    const start = minutes(pair[0], `Termin ${i + 1} Beginn`);
    const end = minutes(pair[1], `Termin ${i + 1} Ende`);
    if (end <= start) throw new ValidationError(`Termin ${i + 1}: Das Ende muss nach dem Beginn liegen.`);
    return [start, end];
  });
}

function typeValues(t) {
  return TYPE_COLUMNS.map((c) => (c === "series_times" && t[c] ? JSON.stringify(t[c]) : t[c]));
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(iso) {
  return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7; // Mo = 0
}

function isoDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new ValidationError("Bitte ein gültiges Datum angeben.");
  }
  return date;
}

function id(value, label) {
  return int(value, label, 1, 2 ** 31 - 1);
}

// Belegte Zeit des Pros: Bei pauschalen Typen ist der Pro für die ganzen Brutto-Stunden
// belegt. Liegt Brutto über der Kurszeit, hängt der Puffer am Ende an
// (Platzreife: Kurs 10:00–12:30, 3 h brutto → belegt bis 13:00).
function bookedEnd(type, start, end) {
  if (type.calc !== "pauschal") return end;
  return Math.min(24 * 60, Math.max(end, start + type.brutto_fix_min));
}

// Uhrzeit eines Termins: Zeit je Termin, feste Zeit des Typs oder die Eingabe
function times(type, body, index = 0) {
  const own = type.series_times?.[index];
  if (own) return { start_min: own[0], end_min: bookedEnd(type, own[0], own[1]) };
  if (type.fixed_start_min !== null) {
    return { start_min: type.fixed_start_min, end_min: bookedEnd(type, type.fixed_start_min, type.fixed_end_min) };
  }
  const start = minutes(body.start_min, "Beginn");
  const end = minutes(body.end_min, "Ende");
  if (end <= start) throw new ValidationError("Das Ende muss nach dem Beginn liegen.");
  return { start_min: start, end_min: bookedEnd(type, start, end) };
}

// Gleicht bestehende Events von Typen mit fester Zeit an die Typ-Einstellungen an
// (z. B. nach einer Änderung der Zeit oder der Brutto-Stunden). $1 = Typ-ID oder NULL für alle.
// Bei Zeit je Termin gilt die Zeit des jeweiligen Termins (series_index).
const SYNC_FIXED_EVENTS_SQL = `
  UPDATE events e
     SET start_min = x.s,
         end_min = CASE WHEN x.calc = 'pauschal' THEN LEAST(1440, GREATEST(x.en, x.s + x.brutto_fix_min)) ELSE x.en END
    FROM (SELECT ev.id, t.calc, t.brutto_fix_min,
                 coalesce((t.series_times -> (ev.series_index - 1) ->> 0)::int, t.fixed_start_min) AS s,
                 coalesce((t.series_times -> (ev.series_index - 1) ->> 1)::int, t.fixed_end_min) AS en
            FROM events ev JOIN event_types t ON t.id = ev.type_id
           WHERE t.fixed_start_min IS NOT NULL AND ($1::int IS NULL OR t.id = $1)) x
   WHERE e.id = x.id`;

// Neues Event bzw. neue Serie: berechnet alle Termine aus Typ und Eingabe.
// body.pros (optional) wählt pro Termin einen eigenen Pro, sonst gilt body.pro_id.
function planNew(type, body) {
  const date = isoDate(body.date);
  if (type.first_weekday !== null && weekdayOf(date) !== type.first_weekday) {
    throw new ValidationError(`«${type.name}» beginnt immer an einem ${WEEKDAYS[type.first_weekday]}.`);
  }
  const offsets = type.series_offsets;
  const pros = Array.isArray(body.pros) ? body.pros : [];
  const fallback = empty(body.pro_id) ? null : body.pro_id;
  const seriesId = offsets.length > 1 ? crypto.randomUUID() : null;
  const notiz = String(body.notiz || "").trim().slice(0, 500);

  return offsets.map((offset, i) => ({
    type_id: type.id,
    pro_id: id(empty(pros[i]) ? fallback : pros[i], offsets.length > 1 ? `Pro für Termin ${i + 1}` : "Pro"),
    date: addDays(date, offset),
    ...times(type, body, i),
    notiz,
    series_id: seriesId,
    series_index: seriesId ? i + 1 : null,
  }));
}

// Bestehendes Event ändern. Termine einer Serie behalten Datum und Zeit,
// nur Pro und Notiz lassen sich pro Termin ändern.
function planUpdate(existing, type, body) {
  const notiz = String(body.notiz || "").trim().slice(0, 500);
  if (existing.series_id) {
    return { ...existing, pro_id: id(body.pro_id, "Pro"), notiz };
  }
  if (type.series_offsets.length > 1) {
    throw new ValidationError("Ein Serien-Typ kann nur neu angelegt werden, nicht aus einem bestehenden Event.");
  }
  const date = isoDate(body.date);
  if (type.first_weekday !== null && weekdayOf(date) !== type.first_weekday) {
    throw new ValidationError(`«${type.name}» findet nur an einem ${WEEKDAYS[type.first_weekday]} statt.`);
  }
  return { ...existing, type_id: type.id, pro_id: id(body.pro_id, "Pro"), date, ...times(type, body), notiz };
}

module.exports = {
  SEED_TYPES, SEED_SERIES_TYPES, TYPE_COLUMNS, WEEKDAYS, ValidationError,
  normalizeType, typeValues, planNew, planUpdate, id, SYNC_FIXED_EVENTS_SQL,
};
