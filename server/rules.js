// Planungsregeln (Reiter «Regeln»). Zwei Arten:
//   stunden    – «Zwischen Datum von und bis müssen <Vergleich> <stunden> Sollstunden von <Kurs> stattfinden.»
//                Obergrenzen (genau, höchstens) sperren das Einplanen; Untergrenzen erfüllt «Auslasten».
//   wochentage – «Mindestens <prozent> % der Sollstunden von <Kursen> müssen an <Tagen> stattfinden.»
//                Wird angezeigt und von «Auslasten» eingehalten, sperrt aber nicht.
// Gezählt werden Brutto-Stunden über alle Pros; jeder Termin zählt mit seinem eigenen Datum.

const { ValidationError, WEEKDAYS } = require("./events");

const EPS = 0.01; // Stunden bzw. Prozentpunkte

const OPS = {
  min: { label: "mindestens", ok: (h, z) => h >= z - EPS, upper: false },
  eq: { label: "genau", ok: (h, z) => Math.abs(h - z) <= EPS, upper: true },
  gt: { label: "mehr als", ok: (h, z) => h > z + EPS, upper: false },
  max: { label: "höchstens", ok: (h, z) => h <= z + EPS, upper: true },
};

const COLUMNS = ["art", "type_id", "type_ids", "von", "bis", "operator", "stunden", "prozent", "wochentage", "aktiv", "notiz"];

function isoDate(value, label) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new ValidationError(`${label}: bitte ein gültiges Datum angeben.`);
  }
  return date;
}

const typeIdOf = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ValidationError("Bitte einen Kurs wählen.");
  return n;
};

function normalize(body) {
  const base = { aktiv: body.aktiv !== false, notiz: String(body.notiz || "").trim().slice(0, 300) };
  const empty = { type_id: null, type_ids: null, von: null, bis: null, operator: null, stunden: null, prozent: null, wochentage: null };

  if (body.art === "wochentage") {
    const typeIds = [...new Set((Array.isArray(body.type_ids) ? body.type_ids : []).map(typeIdOf))];
    if (!typeIds.length) throw new ValidationError("Bitte mindestens einen Kurs wählen.");
    const days = [...new Set((Array.isArray(body.wochentage) ? body.wochentage : []).map(Number))].sort();
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new ValidationError("Bitte mindestens einen Wochentag wählen.");
    }
    const prozent = Math.round(Number(body.prozent) * 10) / 10;
    if (body.prozent === null || body.prozent === "" || !(prozent >= 0 && prozent <= 100)) {
      throw new ValidationError("Anteil: bitte eine Zahl von 0 bis 100 (%).");
    }
    return { ...empty, ...base, art: "wochentage", type_ids: typeIds, wochentage: days, prozent };
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
  const key = days.join(",");
  if (key === "0,1,2,3,4") return "an Wochentagen (Mo–Fr)";
  if (key === "5,6") return "am Wochenende (Sa, So)";
  return `am ${days.map((d) => SHORT_DAYS[d]).join(", ")}`;
}

// Satz zur Regel; nameOf(typId) liefert den Kursnamen
function describe(rule, nameOf) {
  if (rule.art === "wochentage") {
    const names = rule.type_ids.map(nameOf).filter(Boolean);
    return `Mindestens ${rule.prozent} % der Sollstunden von ${names.join(", ") || "(Kurs gelöscht)"} ${daysText(rule.wochentage)}`;
  }
  const day = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  return `Zwischen ${day(rule.von)} und ${day(rule.bis)} ${OPS[rule.operator].label} ${rule.stunden} h von ${nameOf(rule.type_id)}`;
}

module.exports = { OPS, COLUMNS, EPS, normalize, values, describe, daysText };
