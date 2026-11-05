// Kurstypen (Vorlagen) und geplante Kurse: Prüfung der Eingaben und Terminberechnung.
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
//   einplanbar_von/einplanbar_bis – alle Termine müssen in diesem Zeitraum liegen
//   max_stunden                   – höchstens so viele Sollstunden (brutto) für diesen Typ, über alle Pros
//   series_times                  – Serie: eigene Zeit je Termin, z. B. [[840, 990], [600, 750], [840, 990]]
//                                   (dann sind auch mehrere Termine am selben Tag möglich)
//   nicht_parallel                – IDs der Kurstypen, die sich zeitlich nicht mit diesem überschneiden dürfen
//                                   (gegenseitig gespeichert, gilt für alle Pros eines Plans)

const crypto = require("crypto");

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

const SEED_TYPES = [
  { name: "Einzelstunde", einsatzbereich: "kurse", calc: "faktor", brutto_min: 30, netto_min: 25, color: "#6a8fd8" },
];

// Neuer Typ, der einmalig beim Ausbau auf Serien angelegt wird.
const SEED_SERIES_TYPES = [
  {
    name: "Platzreife Teil 1 A",
    einsatzbereich: "kurse",
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

// Einsatzbereich eines Kurstyps → Häkchen beim Pro (leer = alle Pros)
const AREAS = {
  kurse: { label: "Kurse", proField: "kurse" },
  bambini: { label: "Bambini", proField: "bambinitraining" },
  gce: { label: "GCE", proField: "gce_training" },
};

const TYPE_COLUMNS = [
  "code", "einsatzbereich", "einplanbar_von", "einplanbar_bis", "max_stunden", "name", "color", "calc", "brutto_min", "netto_min", "brutto_fix_min", "netto_fix_min",
  "fixed_start_min", "fixed_end_min", "first_weekday", "series_offsets", "series_times", "nicht_parallel",
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
  if (typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value.trim())) {
    const [h, m] = value.trim().split(":").map(Number);
    // Keine Umrechnung ungültiger Zeiten (z. B. 09:90); 24:00 ist als Ende erlaubt.
    if (m > 59 || h > 24 || (h === 24 && m > 0)) throw new ValidationError(`${label}: «${value}» ist keine gültige Uhrzeit.`);
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
  const einsatzbereich = empty(body.einsatzbereich) ? null : String(body.einsatzbereich);
  if (einsatzbereich && !AREAS[einsatzbereich]) throw new ValidationError("Unbekannter Einsatzbereich.");
  const einplanbar_von = empty(body.einplanbar_von) ? null : isoDate(body.einplanbar_von, "Einplanbar von");
  const einplanbar_bis = empty(body.einplanbar_bis) ? null : isoDate(body.einplanbar_bis, "Einplanbar bis");
  if (einplanbar_von && einplanbar_bis && einplanbar_bis < einplanbar_von) {
    throw new ValidationError("Einplanbar: «bis» liegt vor «von».");
  }
  let max_stunden = null;
  if (!empty(body.max_stunden)) {
    max_stunden = Math.round(Number(body.max_stunden) * 100) / 100;
    if (!(max_stunden > 0 && max_stunden <= 100000)) throw new ValidationError("Max. Sollstunden: bitte eine Zahl grösser als 0.");
  }
  const t = { code, einsatzbereich, einplanbar_von, einplanbar_bis, max_stunden, name, color, calc, brutto_min: 30, netto_min: 30, brutto_fix_min: null, netto_fix_min: null };
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
    // Der Pro ist bis zum Ende inkl. Puffer belegt (pauschal: Beginn + Brutto-Stunden)
    if (same && t.series_times[i][0] < bookedEnd(t, ...t.series_times[i - 1])) {
      throw new ValidationError(`Termin ${i + 1} liegt am selben Tag wie Termin ${i} und muss nach dessen Ende inkl. Puffer beginnen.`);
    }
  }

  // Kurstypen, mit denen sich dieser zeitlich nicht überschneiden darf (gegenseitig, in jedem Plan)
  const others = Array.isArray(body.nicht_parallel) ? body.nicht_parallel : [];
  t.nicht_parallel = [...new Set(others.map((v) => id(v, "Nicht parallel zu")))].sort((a, b) => a - b);
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

// Gibt es das Datum wirklich? (Date.parse akzeptiert z. B. 2027-02-30 und rechnet es in den März um.)
function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function isoDate(value, label) {
  const date = String(value || "");
  if (!validDate(date)) {
    throw new ValidationError(label ? `${label}: «${date}» ist kein gültiges Datum.` : `«${date}» ist kein gültiges Datum.`);
  }
  return date;
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

// Liegen alle Daten im einplanbaren Zeitraum des Typs?
function assertWindow(type, dates) {
  const from = type.einplanbar_von;
  const to = type.einplanbar_bis;
  if (dates.some((d) => (from && d < from) || (to && d > to))) {
    const range = from && to ? `vom ${formatDate(from)} bis ${formatDate(to)}` : from ? `ab ${formatDate(from)}` : `bis ${formatDate(to)}`;
    throw new ValidationError(`«${type.name}» kann nur ${range} eingeplant werden.`);
  }
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

// Gleicht bestehende Kurse von Typen mit fester Zeit an die Typ-Einstellungen an
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

// Daten aller Termine einer Serie ab dem Starttag. blocked(datum) (optional, z. B. Schulferien-Regel)
// gibt für gesperrte Tage einen Grund zurück («findet nicht in den Schulferien statt (…)»): Der Start
// darf nicht gesperrt sein, spätere Termine rutschen samt allen folgenden um je eine Woche weiter.
// from: ab welchem Termin (0-basiert) gerechnet wird, start ist dann dessen Datum (Serie ab hier verschieben)
function seriesDates(type, start, blocked, from = 0) {
  const offsets = type.series_offsets;
  if (!blocked) return offsets.slice(from).map((offset) => addDays(start, offset - offsets[from]));
  const hit = blocked(start);
  if (hit) throw new ValidationError(`«${type.name}» ${hit}.`);
  const dates = [start];
  for (let i = from + 1; i < offsets.length; i++) {
    let date = addDays(dates[i - 1], offsets[i] - offsets[i - 1]);
    for (let guard = 0; blocked(date); guard++) {
      if (guard > 60) throw new ValidationError(`«${type.name}»: kein passender Termin gefunden (Schulferien-Regel).`);
      date = addDays(date, 7);
    }
    dates.push(date);
  }
  return dates;
}

// Neue Daten beim Verschieben einer Serie: Termin «index» (1-basiert) kommt auf «date»; verschoben werden
// bei «folgende» dieser und alle späteren Termine, bei «alle» die ganze Serie um dieselbe Anzahl Tage
// ab Termin 1. Die Abstände der Serie (und das Überspringen der Schulferien) werden neu angewendet;
// einzeln verschobene Termine im betroffenen Bereich rücken dabei wieder ins Muster.
// termine: alle Termine der Serie; liefert Map series_index → Datum.
function movedSeriesDates(type, termine, index, date, scope, blocked) {
  const sorted = [...termine].sort((a, b) => a.series_index - b.series_index);
  const current = sorted.find((t) => t.series_index === index);
  const delta = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${current.date}T00:00:00Z`)) / 86400000);
  const fromIndex = scope === "alle" ? sorted[0].series_index : index;
  const start = scope === "alle" ? addDays(sorted[0].date, delta) : date;
  const moved = sorted.filter((t) => t.series_index >= fromIndex);
  const fits = type.series_offsets.length === sorted.length && sorted.every((t, i) => t.series_index === i + 1);
  // Passt die Serie nicht mehr zum Kurstyp (Termine geändert), alle betroffenen Termine einfach mitschieben
  const dates = fits ? seriesDates(type, start, blocked, fromIndex - 1) : moved.map((t) => addDays(t.date, delta));
  return new Map(moved.map((t, i) => [t.series_index, dates[i]]));
}

// Neuer Kurs bzw. neue Serie: berechnet alle Termine aus Typ und Eingabe.
// body.pros (optional) wählt pro Termin einen eigenen Pro, sonst gilt body.pro_id.
// opts.blocked (optional): Tage, an denen der Typ nicht stattfindet (siehe seriesDates).
function planNew(type, body, opts = {}) {
  const date = isoDate(body.date);
  if (type.first_weekday !== null && weekdayOf(date) !== type.first_weekday) {
    throw new ValidationError(`«${type.name}» beginnt immer an einem ${WEEKDAYS[type.first_weekday]}.`);
  }
  const offsets = type.series_offsets;
  const dates = seriesDates(type, date, opts.blocked);
  const pros = Array.isArray(body.pros) ? body.pros : [];
  const fallback = empty(body.pro_id) ? null : body.pro_id;
  const seriesId = offsets.length > 1 ? crypto.randomUUID() : null;
  const notiz = String(body.notiz || "").trim().slice(0, 500);

  assertWindow(type, dates);
  return offsets.map((offset, i) => ({
    type_id: type.id,
    pro_id: id(empty(pros[i]) ? fallback : pros[i], offsets.length > 1 ? `Pro für Termin ${i + 1}` : "Pro"),
    date: dates[i],
    ...times(type, body, i),
    notiz,
    series_id: seriesId,
    series_index: seriesId ? i + 1 : null,
  }));
}

// Bestehenden Kurs ändern. Termine einer Serie behalten Datum und Zeit,
// nur Pro und Notiz lassen sich pro Termin ändern.
function planUpdate(existing, type, body, opts = {}) {
  const notiz = String(body.notiz || "").trim().slice(0, 500);
  // Serien-Termin: Pro, Notiz und Datum (verschieben); die Zeit bleibt die des Termins.
  // Zeitraum, Schulferien und Belegung prüft planning.planChange für alle betroffenen Termine.
  if (existing.series_id) {
    const date = empty(body.date) ? existing.date : isoDate(body.date);
    return { ...existing, pro_id: id(body.pro_id, "Pro"), date, notiz };
  }
  if (type.series_offsets.length > 1) {
    throw new ValidationError("Ein Serien-Typ kann nur neu angelegt werden, nicht aus einem bestehenden Kurs.");
  }
  const date = isoDate(body.date);
  if (type.first_weekday !== null && weekdayOf(date) !== type.first_weekday) {
    throw new ValidationError(`«${type.name}» findet nur an einem ${WEEKDAYS[type.first_weekday]} statt.`);
  }
  assertWindow(type, [date]);
  const hit = opts.blocked?.(date);
  if (hit) throw new ValidationError(`«${type.name}» ${hit}.`);
  return { ...existing, type_id: type.id, pro_id: id(body.pro_id, "Pro"), date, ...times(type, body), notiz };
}

module.exports = {
  SEED_TYPES, SEED_SERIES_TYPES, TYPE_COLUMNS, WEEKDAYS, AREAS, ValidationError,
  normalizeType, typeValues, planNew, planUpdate, seriesDates, movedSeriesDates, id, addDays, weekdayOf, assertWindow, validDate, SYNC_FIXED_EVENTS_SQL,
};
