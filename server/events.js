// Event-Typen (Vorlagen wie «Einzelstunde») und geplante Events: Prüfung der Eingaben.
//
// Brutto/Netto werden pro 30 Minuten geplanter Zeit angegeben:
//   Einzelstunde: brutto 30 min / netto 25 min pro 30 min
//   → 1 h geplant = 1 h brutto (zählt gegen die Sollstunden) = 50 min netto (Unterricht)

const SEED_TYPES = [{ name: "Einzelstunde", brutto_min: 30, netto_min: 25, color: "#6a8fd8" }];

class ValidationError extends Error {}

function int(value, label, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${label} muss eine ganze Zahl zwischen ${min} und ${max} sein.`);
  }
  return n;
}

function normalizeType(body) {
  const name = String(body.name || "").trim();
  if (!name) throw new ValidationError("Bitte einen Namen eingeben.");
  const brutto = int(body.brutto_min, "Brutto (Minuten pro 30 min)", 0, 30);
  const netto = int(body.netto_min, "Netto (Minuten pro 30 min)", 0, 30);
  if (netto > brutto) throw new ValidationError("Netto darf nicht grösser als Brutto sein.");
  const color = String(body.color || "#6a8fd8");
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new ValidationError("Ungültige Farbe.");
  return { name, brutto_min: brutto, netto_min: netto, color };
}

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

function normalizeEvent(body) {
  const date = String(body.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new ValidationError("Bitte ein gültiges Datum angeben.");
  }
  const start = minutes(body.start_min, "Beginn");
  const end = minutes(body.end_min, "Ende");
  if (end <= start) throw new ValidationError("Das Ende muss nach dem Beginn liegen.");
  return {
    type_id: int(body.type_id, "Event-Typ", 1, 2 ** 31 - 1),
    pro_id: int(body.pro_id, "Pro", 1, 2 ** 31 - 1),
    date,
    start_min: start,
    end_min: end,
    notiz: String(body.notiz || "").trim().slice(0, 500),
  };
}

module.exports = { SEED_TYPES, ValidationError, normalizeType, normalizeEvent };
