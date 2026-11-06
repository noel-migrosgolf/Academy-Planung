// Einstellungen der Pros: Startdaten und Prüfung der Eingaben.

const { validDate: isDate, weekdayOf, addDays } = require("./events");

const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const AVAILABILITY_RULES = ["wochenend_wechsel_AB"];

// Startwerte für die bestehenden Pros (werden einmalig übernommen).
const SEED = [
  { code: "PYN", name: "Yannick", sollstunden: 1200, bambinitraining: false, kurse: true, gce_training: true, freie_tage: ["Montag"], auslastung_soll_prozent: 100, abwesenheiten: [], verfuegbarkeitsregel: null },
  { code: "PBK", name: "Benedikt", sollstunden: 1200, bambinitraining: true, kurse: true, gce_training: false, freie_tage: ["Montag"], auslastung_soll_prozent: 100, abwesenheiten: [], verfuegbarkeitsregel: null },
  { code: "PTS", name: "Thore", sollstunden: 1000, bambinitraining: false, kurse: true, gce_training: true, freie_tage: [], auslastung_soll_prozent: 100, abwesenheiten: [], verfuegbarkeitsregel: "wochenend_wechsel_AB" },
  { code: "PAS", name: "Aaron", sollstunden: 1000, bambinitraining: false, kurse: true, gce_training: true, freie_tage: ["Montag", "Dienstag"], auslastung_soll_prozent: 100, abwesenheiten: [], verfuegbarkeitsregel: null },
  { code: "PJC", name: "Joseph", sollstunden: 750, bambinitraining: true, kurse: true, gce_training: true, freie_tage: ["Donnerstag", "Sonntag"], auslastung_soll_prozent: 100, abwesenheiten: [], verfuegbarkeitsregel: null },
  { code: "PAE", name: "Anja", sollstunden: 250, bambinitraining: true, kurse: false, gce_training: true, freie_tage: ["Mittwoch", "Samstag", "Sonntag"], auslastung_soll_prozent: 100, abwesenheiten: [], verfuegbarkeitsregel: null },
  { code: "PLW", name: "Leigh", sollstunden: 1200, bambinitraining: false, kurse: true, gce_training: true, freie_tage: ["Mittwoch", "Donnerstag"], auslastung_soll_prozent: 100, abwesenheiten: [], verfuegbarkeitsregel: null },
];

const COLUMNS = [
  "code", "name", "sollstunden", "bambinitraining", "kurse", "gce_training",
  "freie_tage", "auslastung_soll_prozent", "abwesenheiten", "verfuegbarkeitsregel", "wechsel",
];

// Wochenend-Wechsel A/B: A- und B-Wochen wechseln sich ab, beginnend mit der A-Woche ab a_woche (Montag);
// in A-Wochen sind die Tage a_frei frei, in B-Wochen die Tage b_frei (z. B. A: Fr frei, Sa/So Arbeit;
// B: Fr Arbeit, Sa/So frei). Feste freie Tage (freie_tage) gelten zusätzlich in jeder Woche.
const DEFAULT_WECHSEL = { a_woche: "2027-01-04", a_frei: ["Freitag"], b_frei: ["Samstag", "Sonntag"] };

const mondayOf = (iso) => addDays(iso, -weekdayOf(iso));

function abWeek(wechsel, date) {
  const weeks = Math.round((Date.parse(mondayOf(date)) - Date.parse(mondayOf(wechsel.a_woche))) / (7 * 86400000));
  return weeks % 2 === 0 ? "A" : "B";
}

// Hat der Pro an diesem Datum frei (fester freier Tag oder Wochenend-Wechsel)? Grund als Text oder null.
function freeReason(pro, date) {
  const day = WEEKDAYS[weekdayOf(date)];
  if ((pro.freie_tage || []).includes(day)) return `${day} ist ein freier Tag`;
  const w = pro.verfuegbarkeitsregel === "wochenend_wechsel_AB" ? pro.wechsel || DEFAULT_WECHSEL : null;
  if (!w) return null;
  const ab = abWeek(w, date);
  return (ab === "A" ? w.a_frei : w.b_frei).includes(day) ? `${day} frei (${ab}-Woche, Wochenend-Wechsel)` : null;
}

class ValidationError extends Error {}


function wholeNumber(value, label, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new ValidationError(`${label} muss eine ganze Zahl zwischen 0 und ${max} sein.`);
  }
  return n;
}

// Prüft und vereinheitlicht die Eingaben aus dem Formular.
function normalize(body) {
  const name = String(body.name || "").trim();
  if (!name) throw new ValidationError("Bitte einen Namen eingeben.");

  const code = String(body.code || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(code)) {
    throw new ValidationError("Kürzel: 2–10 Buchstaben oder Ziffern (z. B. PYN).");
  }

  const freieTage = Array.isArray(body.freie_tage) ? body.freie_tage : [];
  if (freieTage.some((d) => !WEEKDAYS.includes(d))) throw new ValidationError("Ungültiger Wochentag bei den freien Tagen.");

  const regel = body.verfuegbarkeitsregel || null;
  if (regel !== null && !AVAILABILITY_RULES.includes(regel)) throw new ValidationError("Ungültige Verfügbarkeitsregel.");
  let wechsel = null;
  if (regel === "wochenend_wechsel_AB") {
    const w = body.wechsel || DEFAULT_WECHSEL;
    const days = (list, label) => {
      const arr = Array.isArray(list) ? list : [];
      if (arr.some((d) => !WEEKDAYS.includes(d))) throw new ValidationError(`Wochenend-Wechsel: ungültiger Wochentag (${label}).`);
      return WEEKDAYS.filter((d) => arr.includes(d));
    };
    if (!isDate(String(w.a_woche || ""))) throw new ValidationError("Wochenend-Wechsel: bitte ein Datum in einer A-Woche angeben.");
    wechsel = { a_woche: mondayOf(w.a_woche), a_frei: days(w.a_frei, "A-Woche"), b_frei: days(w.b_frei, "B-Woche") };
  }

  const abwesenheiten = (Array.isArray(body.abwesenheiten) ? body.abwesenheiten : []).map((a) => {
    const von = String(a?.von || "");
    const bis = String(a?.bis || von);
    if (!isDate(von) || !isDate(bis)) throw new ValidationError("Abwesenheit: Bitte gültige Daten angeben.");
    if (bis < von) throw new ValidationError("Abwesenheit: «bis» liegt vor «von».");
    return { von, bis, grund: String(a?.grund || "").trim() };
  });

  return {
    code,
    name,
    sollstunden: wholeNumber(body.sollstunden ?? 0, "Sollstunden", 5000),
    bambinitraining: body.bambinitraining === true,
    kurse: body.kurse === true,
    gce_training: body.gce_training === true,
    freie_tage: WEEKDAYS.filter((d) => freieTage.includes(d)),
    auslastung_soll_prozent: wholeNumber(body.auslastung_soll_prozent ?? 100, "Soll-Auslastung", 200),
    abwesenheiten,
    verfuegbarkeitsregel: regel,
    wechsel,
  };
}

// Werte in der Reihenfolge von COLUMNS (abwesenheiten als JSON).
function values(pro) {
  return COLUMNS.map((c) => (c === "abwesenheiten" || c === "wechsel" ? (pro[c] === null ? null : JSON.stringify(pro[c])) : pro[c]));
}

module.exports = { SEED, COLUMNS, WEEKDAYS, DEFAULT_WECHSEL, ValidationError, normalize, values, freeReason, abWeek };
