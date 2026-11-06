// Planungsregeln (Reiter «Regeln»). Zwei Arten:
//   stunden    – «Zwischen Datum von und bis müssen <Vergleich> <stunden> Sollstunden von <Kurs> stattfinden.»
//                Obergrenzen (genau, höchstens) sperren das Einplanen; Untergrenzen erfüllt «Auslasten».
//   wochentage – «Mindestens <prozent> % der Sollstunden von <Kursen> müssen an <Tagen> [zwischen <zeit_von> und
//                <zeit_bis>] stattfinden.» Ein Termin zählt, wenn sein Wochentag passt (keine Tage = jeder Tag) und
//                sein Unterricht (Beginn bis Ende ohne Puffer) im Zeitfenster liegt.
//                Wird angezeigt und von «Auslasten» eingehalten, sperrt aber nicht.
//   ferien     – modus «ausserhalb»: «<Kurse> finden nicht in den Schulferien (Kanton Zug) statt.»
//                modus «innerhalb»:  «<Kurse> finden nur in den Schulferien (Kanton Zug) statt.»
//                Sperrt Termine an nicht erlaubten Tagen; Serien überspringen solche Wochen
//                (die Termine rutschen um je eine Woche weiter).
// Gezählt werden Brutto-Stunden über alle Pros; jeder Termin zählt mit seinem eigenen Datum.

const { ValidationError, WEEKDAYS, validDate, minutes } = require("./events");

const EPS = 0.01; // Stunden bzw. Prozentpunkte

const OPS = {
  min: { label: "mindestens", ok: (h, z) => h >= z - EPS, upper: false },
  eq: { label: "genau", ok: (h, z) => Math.abs(h - z) <= EPS, upper: true },
  gt: { label: "mehr als", ok: (h, z) => h > z + EPS, upper: false },
  max: { label: "höchstens", ok: (h, z) => h <= z + EPS, upper: true },
};

const COLUMNS = ["art", "type_id", "type_ids", "von", "bis", "operator", "stunden", "prozent", "wochentage", "modus", "zeit_von", "zeit_bis", "aktiv", "notiz"];
const FERIEN_MODI = ["ausserhalb", "innerhalb"];

function isoDate(value, label) {
  const date = String(value || "");
  if (!validDate(date)) throw new ValidationError(`${label}: «${date}» ist kein gültiges Datum.`);
  return date;
}

const typeIdOf = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError("Bitte einen Kurs wählen.");
  return n;
};

function normalize(body) {
  const base = { aktiv: body.aktiv !== false, notiz: String(body.notiz || "").trim().slice(0, 300) };
  const empty = { type_id: null, type_ids: null, von: null, bis: null, operator: null, stunden: null, prozent: null, wochentage: null, modus: null, zeit_von: null, zeit_bis: null };

  if (body.art === "ferien") {
    const typeIds = [...new Set((Array.isArray(body.type_ids) ? body.type_ids : []).map(typeIdOf))];
    if (!typeIds.length) throw new ValidationError("Bitte mindestens einen Kurs wählen.");
    const modus = body.modus ?? "ausserhalb";
    if (!FERIEN_MODI.includes(modus)) throw new ValidationError("Schulferien: bitte «ausserhalb» oder «innerhalb» wählen.");
    return { ...empty, ...base, art: "ferien", type_ids: typeIds, modus };
  }

  if (body.art === "wochentage") {
    const typeIds = [...new Set((Array.isArray(body.type_ids) ? body.type_ids : []).map(typeIdOf))];
    if (!typeIds.length) throw new ValidationError("Bitte mindestens einen Kurs wählen.");
    const days = [...new Set((Array.isArray(body.wochentage) ? body.wochentage : []).map(Number))].sort();
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new ValidationError("Ungültiger Wochentag.");
    // Zeitfenster (optional): beide Zeiten oder keine
    const blank = (v) => v === null || v === undefined || v === "";
    if (blank(body.zeit_von) !== blank(body.zeit_bis)) throw new ValidationError("Zeitfenster: bitte «von» und «bis» angeben (oder beide leer lassen).");
    const zeit_von = blank(body.zeit_von) ? null : minutes(body.zeit_von, "Zeitfenster von");
    const zeit_bis = blank(body.zeit_bis) ? null : minutes(body.zeit_bis, "Zeitfenster bis");
    if (zeit_von !== null && zeit_bis <= zeit_von) throw new ValidationError("Zeitfenster: «bis» muss nach «von» liegen.");
    if (!days.length && zeit_von === null) throw new ValidationError("Bitte Wochentage und/oder ein Zeitfenster wählen.");
    const prozent = Math.round(Number(body.prozent) * 10) / 10;
    if (body.prozent === null || body.prozent === "" || !(prozent >= 0 && prozent <= 100)) {
      throw new ValidationError("Anteil: bitte eine Zahl von 0 bis 100 (%).");
    }
    return { ...empty, ...base, art: "wochentage", type_ids: typeIds, wochentage: days, prozent, zeit_von, zeit_bis };
  }

  const von = isoDate(body.von, "Von");
  const bis = isoDate(body.bis, "Bis");
  if (bis < von) throw new ValidationError("«Bis» liegt vor «von».");
  if (!OPS[body.operator]) throw new ValidationError("Bitte einen Vergleich wählen (mindestens, genau, mehr als, höchstens).");
  if (body.stunden === null || body.stunden === undefined || body.stunden === "") {
    throw new ValidationError("Bitte die Sollstunden angeben.");
  }
  const stunden = Math.round(Number(body.stunden) * 100) / 100;
  if (!(stunden >= 0 && stunden <= 100000)) throw new ValidationError("Sollstunden: bitte eine Zahl ab 0.");
  return { ...empty, ...base, art: "stunden", type_id: typeIdOf(body.type_id), von, bis, operator: body.operator, stunden };
}

const values = (r) => COLUMNS.map((c) => r[c]);

const SHORT_DAYS = WEEKDAYS.map((d) => d.slice(0, 2));

// «an Wochentagen (Mo–Fr)», «am Wochenende (Sa, So)» oder «am Mo, Mi, Fr»
function daysText(days) {
  if (!days.length) return "";
  const key = days.join(",");
  if (key === "0,1,2,3,4") return "an Wochentagen (Mo–Fr)";
  if (key === "5,6") return "am Wochenende (Sa, So)";
  return `am ${days.map((d) => SHORT_DAYS[d]).join(", ")}`;
}

// Zählt ein Termin für eine Anteil-Regel? Wochentag passt (keine Tage = jeder Tag) und, falls gesetzt,
// der Unterricht liegt im Zeitfenster: Beginn ab zeit_von, Unterrichtsende (Beginn + Netto) bis zeit_bis.
// nettoMin: Netto-Minuten des Termins; weekday: 0 = Mo … 6 = So
function shareHit(rule, ev, weekday, nettoMin) {
  if (rule.wochentage?.length && !rule.wochentage.includes(weekday)) return false;
  if (rule.zeit_von === null || rule.zeit_von === undefined) return true;
  return ev.start_min >= rule.zeit_von && ev.start_min + nettoMin <= rule.zeit_bis;
}

// Satz zur Regel; nameOf(typId) liefert den Kursnamen
function describe(rule, nameOf) {
  if (rule.art === "ferien") {
    const names = rule.type_ids.map(nameOf).filter(Boolean);
    const where = rule.modus === "innerhalb" ? "nur in" : "nicht in";
    return `${names.join(", ") || "(Kurs gelöscht)"} ${names.length > 1 ? "finden" : "findet"} ${where} den Schulferien (Kanton Zug) statt`;
  }
  if (rule.art === "wochentage") {
    const names = rule.type_ids.map(nameOf).filter(Boolean);
    const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const when = [daysText(rule.wochentage), rule.zeit_von !== null && rule.zeit_von !== undefined ? `zwischen ${clock(rule.zeit_von)} und ${clock(rule.zeit_bis)}` : ""].filter(Boolean).join(" ");
    return `Mindestens ${rule.prozent} % der Sollstunden von ${names.join(", ") || "(Kurs gelöscht)"} ${when}`;
  }
  const day = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  return `Zwischen ${day(rule.von)} und ${day(rule.bis)} ${OPS[rule.operator].label} ${rule.stunden} h von ${nameOf(rule.type_id)}`;
}

module.exports = { OPS, COLUMNS, FERIEN_MODI, EPS, normalize, values, describe, daysText, shareHit };
