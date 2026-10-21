// Planungsregeln. Erster Regeltyp:
//   «Zwischen Datum von und bis müssen <Vergleich> <stunden> Sollstunden (brutto) von <Kurs> stattfinden.»
// Gezählt werden alle Termine des Kurses (über alle Pros), deren Datum im Zeitraum liegt.
// Obergrenzen (genau, höchstens) sperren das Einplanen darüber hinaus; Untergrenzen erfüllt «Auslasten».

const { ValidationError } = require("./events");

const EPS = 0.01; // Stunden

const OPS = {
  min: { label: "mindestens", ok: (h, z) => h >= z - EPS, upper: false },
  eq: { label: "genau", ok: (h, z) => Math.abs(h - z) <= EPS, upper: true },
  gt: { label: "mehr als", ok: (h, z) => h > z + EPS, upper: false },
  max: { label: "höchstens", ok: (h, z) => h <= z + EPS, upper: true },
};

const COLUMNS = ["type_id", "von", "bis", "operator", "stunden", "aktiv", "notiz"];

function isoDate(value, label) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new ValidationError(`${label}: bitte ein gültiges Datum angeben.`);
  }
  return date;
}

function normalize(body) {
  const typeId = Number(body.type_id);
  if (!Number.isInteger(typeId) || typeId < 1) throw new ValidationError("Bitte einen Kurs wählen.");
  const von = isoDate(body.von, "Von");
  const bis = isoDate(body.bis, "Bis");
  if (bis < von) throw new ValidationError("«Bis» liegt vor «von».");
  if (!OPS[body.operator]) throw new ValidationError("Bitte einen Vergleich wählen (mindestens, genau, mehr als, höchstens).");
  if (body.stunden === null || body.stunden === undefined || body.stunden === "") {
    throw new ValidationError("Bitte die Sollstunden angeben.");
  }
  const stunden = Math.round(Number(body.stunden) * 100) / 100;
  if (!(stunden >= 0 && stunden <= 100000)) throw new ValidationError("Sollstunden: bitte eine Zahl ab 0.");
  return {
    type_id: typeId,
    von,
    bis,
    operator: body.operator,
    stunden,
    aktiv: body.aktiv !== false,
    notiz: String(body.notiz || "").trim().slice(0, 300),
  };
}

const values = (r) => COLUMNS.map((c) => r[c]);

// «Zwischen 01.04.2027 und 30.06.2027 mindestens 30 h von Platzreife Teil 1 A»
function describe(rule, typeName) {
  const day = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  return `Zwischen ${day(rule.von)} und ${day(rule.bis)} ${OPS[rule.operator].label} ${rule.stunden} h von ${typeName}`;
}

module.exports = { OPS, COLUMNS, EPS, normalize, values, describe };
