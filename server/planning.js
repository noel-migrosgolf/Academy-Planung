// Planungslogik, gemeinsam genutzt von der API und der KI:
// lesefreundliche Übersicht (Namen statt IDs) sowie Sammel-Aktionen
// (anlegen, ändern, löschen) als Transaktion «alles oder nichts», wahlweise als Probelauf.

const { pool } = require("./db");
const eventsData = require("./events");
const rulesData = require("./rules");

const TYPE_FIELDS = `id, ${eventsData.TYPE_COLUMNS.join(", ")}`;
const EVENT_FIELDS =
  "id, type_id, pro_id, to_char(date, 'YYYY-MM-DD') AS date, start_min, end_min, notiz, series_id, series_index";

class PlanningError extends eventsData.ValidationError {}

async function loadType(db, typeId) {
  const { rows } = await db.query(`SELECT ${TYPE_FIELDS} FROM event_types WHERE id = $1`, [typeId]);
  if (!rows[0]) throw new eventsData.ValidationError("Event-Typ existiert nicht.");
  return rows[0];
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

// Uhrzeit «HH:MM» oder Minuten seit Mitternacht
function timeArg(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : value;
}

function clock(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// Brutto bzw. Netto eines Events in Minuten (wie im Frontend, public/js/events.js)
function minutesOf(ev, type, mode) {
  if (!type) return 0;
  if (type.calc === "pauschal") return mode === "netto" ? type.netto_fix_min : type.brutto_fix_min;
  return ((ev.end_min - ev.start_min) * (mode === "netto" ? type.netto_min : type.brutto_min)) / 30;
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

// Ein Pro darf nur Typen seines Einsatzbereichs übernehmen (Typ ohne Bereich: alle Pros).
function areaAllows(type, pro) {
  const area = eventsData.AREAS[type.einsatzbereich];
  return !area || pro[area.proField] === true;
}

async function assertArea(db, type, proIds, label = "") {
  const area = eventsData.AREAS[type.einsatzbereich];
  if (!area) return;
  const { rows } = await db.query(
    `SELECT name FROM pros WHERE id = ANY($1::int[]) AND NOT ${area.proField} ORDER BY name`,
    [[...new Set(proIds)]]
  );
  if (rows.length) {
    const names = rows.map((r) => `«${r.name}»`).join(", ");
    throw new eventsData.ValidationError(`${label}${names} ${rows.length > 1 ? "sind" : "ist"} nicht im Einsatzbereich ${area.label}.`);
  }
}

// Höchstens max_stunden Sollstunden (brutto) je Typ, über alle Pros.
async function usedMinutes(db, type) {
  const { rows } = await db.query("SELECT start_min, end_min FROM events WHERE type_id = $1", [type.id]);
  return rows.reduce((sum, ev) => sum + minutesOf(ev, type, "brutto"), 0);
}

const hoursText = (min) => `${Math.round((min / 60) * 10) / 10} h`;

// addMinutes: zusätzliche Brutto-Minuten durch die Änderung (bei Änderungen die Differenz)
async function assertCapacity(db, type, addMinutes, label = "") {
  if (!type.max_stunden || addMinutes <= 0) return;
  const used = await usedMinutes(db, type);
  if (used + addMinutes > type.max_stunden * 60 + 0.01) {
    throw new eventsData.ValidationError(
      `${label}«${type.name}»: höchstens ${type.max_stunden} Sollstunden, bereits ${hoursText(used)} geplant, dazu kämen ${hoursText(addMinutes)}.`
    );
  }
}

const sumBrutto = (events, type) => events.reduce((sum, ev) => sum + minutesOf(ev, type, "brutto"), 0);

// --- Namen auflösen (Pro per Name oder Kürzel, Typ per Name oder ID) ---

async function lookups(db) {
  const [pros, types] = await Promise.all([
    db.query("SELECT id, code, name, sollstunden, freie_tage, kurse, bambinitraining, gce_training, abwesenheiten FROM pros ORDER BY sort_order, id"),
    db.query(`SELECT ${TYPE_FIELDS} FROM event_types ORDER BY sort_order, id`),
  ]);
  return { pros: pros.rows, types: types.rows };
}

function findPro(lk, value) {
  if (value === null || value === undefined || value === "") return null;
  if (Number.isInteger(value)) return lk.pros.find((p) => p.id === value) || null;
  const v = String(value).trim().toLowerCase();
  return lk.pros.find((p) => p.name.toLowerCase() === v || (p.code || "").toLowerCase() === v) || null;
}

function findType(lk, value) {
  if (value === null || value === undefined || value === "") return null;
  if (Number.isInteger(value)) return lk.types.find((t) => t.id === value) || null;
  const v = String(value).trim().toLowerCase();
  return lk.types.find((t) => t.name.toLowerCase() === v || (t.code || "").toLowerCase() === v) || null;
}

function requirePro(lk, value, label) {
  const pro = findPro(lk, value);
  if (!pro) throw new PlanningError(`${label}Pro «${value}» nicht gefunden.`);
  return pro.id;
}

// --- Lesefreundliche Übersicht ---

async function overview({ from, to, pro } = {}, db = pool) {
  const lk = await lookups(db);
  const typeById = new Map(lk.types.map((t) => [t.id, t]));
  const proById = new Map(lk.pros.map((p) => [p.id, p]));
  const proFilter = pro ? findPro(lk, pro) : null;
  if (pro && !proFilter) throw new PlanningError(`Pro «${pro}» nicht gefunden.`);

  const { rows: all } = await db.query(`SELECT ${EVENT_FIELDS} FROM events ORDER BY date, start_min, id`);
  const planned = new Map();
  for (const ev of all) {
    const t = typeById.get(ev.type_id);
    const sum = planned.get(ev.pro_id) || { brutto: 0, netto: 0 };
    sum.brutto += minutesOf(ev, t, "brutto");
    sum.netto += minutesOf(ev, t, "netto");
    planned.set(ev.pro_id, sum);
  }

  const inRange = all.filter(
    (ev) => (!from || ev.date >= from) && (!to || ev.date <= to) && (!proFilter || ev.pro_id === proFilter.id)
  );

  const regeln = (await ruleStatus(db)).filter((r) => r.aktiv);
  return {
    regeln: regeln.map((r) => ({
      id: `R${r.id}`,
      regel: r.text,
      ist: r.art === "wochentage" ? (r.ist_prozent === null ? "noch nichts geplant" : `${r.ist_prozent} %`) : `${r.ist_stunden} h`,
      erfuellt: r.erfuellt,
    })),
    pros: lk.pros.map((p) => {
      const sum = planned.get(p.id) || { brutto: 0, netto: 0 };
      return {
        name: p.name,
        kuerzel: p.code,
        sollstunden: p.sollstunden,
        geplant_brutto_h: Math.round((sum.brutto / 60) * 100) / 100,
        geplant_netto_h: Math.round((sum.netto / 60) * 100) / 100,
        auslastung_prozent: p.sollstunden ? Math.round((sum.brutto / 60 / p.sollstunden) * 1000) / 10 : null,
        freie_tage: p.freie_tage,
        einsatz: [p.kurse && "Kurse", p.bambinitraining && "Bambini", p.gce_training && "GCE"].filter(Boolean),
        abwesenheiten: p.abwesenheiten,
      };
    }),
    typen: lk.types.map((t) => ({
      id: t.code,
      bereich: eventsData.AREAS[t.einsatzbereich]?.label || "alle",
      einplanbar: t.einplanbar_von || t.einplanbar_bis ? `${t.einplanbar_von || "…"} bis ${t.einplanbar_bis || "…"}` : "ganzes Jahr",
      max_stunden: t.max_stunden,
      name: t.name,
      stunden: t.calc === "pauschal"
        ? `pro Termin ${t.brutto_fix_min / 60} h brutto, ${t.netto_fix_min / 60} h netto`
        : `${t.brutto_min}/${t.netto_min} min brutto/netto pro 30 min`,
      zeit: t.series_times
        ? `je Termin ${t.series_times.map(([a, b]) => `${clock(a)}–${clock(b)}`).join(", ")}`
        : t.fixed_start_min !== null ? `${clock(t.fixed_start_min)}–${clock(t.fixed_end_min)}` : "frei",
      erster_wochentag: t.first_weekday !== null ? eventsData.WEEKDAYS[t.first_weekday] : null,
      termine_tage_ab_start: t.series_offsets,
    })),
    events: inRange.map((ev) => {
      const t = typeById.get(ev.type_id);
      return {
        id: ev.id,
        datum: ev.date,
        zeit: `${clock(ev.start_min)}–${clock(ev.end_min)}`,
        pro: proById.get(ev.pro_id)?.name ?? "?",
        typ: t?.name ?? "?",
        serie: ev.series_id ? `${ev.series_index}/${t?.series_offsets.length ?? "?"}` : null,
        notiz: ev.notiz || null,
      };
    }),
  };
}

// Kompakte Textform der Übersicht (spart Tokens gegenüber JSON)
function overviewText(o, { maxEvents = 400, parts = ["regeln", "pros", "typen", "events"] } = {}) {
  const lines = [];
  if (parts.includes("regeln") && o.regeln.length) {
    lines.push("REGELN (ID|Regel|ist|erfüllt)");
    for (const r of o.regeln) lines.push([r.id, r.regel, r.ist, r.erfuellt ? "ja" : "nein"].join("|"));
  }
  if (parts.includes("pros")) {
    lines.push("PROS (Name|Kürzel|Soll h|geplant brutto h|netto h|Auslastung %|frei|Einsatz)");
    for (const p of o.pros) {
      lines.push([p.name, p.kuerzel, p.sollstunden, p.geplant_brutto_h, p.geplant_netto_h, p.auslastung_prozent,
        p.freie_tage.join(",") || "-", p.einsatz.join(",") || "-"].join("|"));
    }
  }
  if (parts.includes("typen")) {
    lines.push("TYPEN (ID|Name|Einsatzbereich|einplanbar|max. Sollstunden|Stunden|Zeit|erster Wochentag|Termine Tage ab Start)");
    for (const t of o.typen) {
      lines.push([t.id || "-", t.name, t.bereich, t.einplanbar, t.max_stunden ?? "-", t.stunden, t.zeit, t.erster_wochentag || "-", t.termine_tage_ab_start.join(",")].join("|"));
    }
  }
  if (parts.includes("events")) {
    lines.push(`EVENTS ${o.events.length} (id|Datum|Zeit|Pro|Typ|Serie|Notiz)`);
    for (const e of o.events.slice(0, maxEvents)) {
      lines.push([e.id, e.datum, e.zeit, e.pro, e.typ, e.serie || "-", e.notiz || ""].join("|"));
    }
    if (o.events.length > maxEvents) lines.push(`… ${o.events.length - maxEvents} weitere, Zeitraum oder Pro eingrenzen`);
  }
  return lines.join("\n");
}

// --- Sammel-Aktionen ---

// Führt fn in einer Transaktion aus. Probelauf oder Fehler: am Ende ROLLBACK.
// Nach einem echten Lauf mit Fehlern ist nichts geändert, die Listen sind dann leer.
async function transaction(dryRun, listKey, fn) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query(dryRun || result.errors.length ? "ROLLBACK" : "COMMIT");
    if (!dryRun && result.errors.length) result[listKey] = [];
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

// Fehler pro Eintrag sammeln statt beim ersten abzubrechen (Savepoint je Eintrag)
async function eachItem(db, items, errors, fn) {
  for (const [i, item] of items.entries()) {
    await db.query("SAVEPOINT item");
    try {
      await fn(item, i);
      await db.query("RELEASE SAVEPOINT item");
    } catch (err) {
      await db.query("ROLLBACK TO SAVEPOINT item");
      if (!(err instanceof eventsData.ValidationError)) throw err;
      errors.push({ eintrag: i + 1, fehler: err.message });
    }
  }
}

// items: [{ typ|type_id, pro|pro_id, datum|date, von|start_min, bis|end_min, pros?, notiz? }] – Zeiten als «HH:MM» oder Minuten
// pros: optional ein Pro pro Termin einer Serie (Name, Kürzel oder ID; leer = wie pro)
async function bulkCreate(items, { dryRun = false, userId = null } = {}) {
  if (!Array.isArray(items) || !items.length) throw new PlanningError("Keine Events angegeben.");
  if (items.length > 200) throw new PlanningError("Höchstens 200 Einträge pro Aufruf.");
  return transaction(dryRun, "created", async (db) => {
    const lk = await lookups(db);
    const created = [];
    const errors = [];
    await eachItem(db, items, errors, async (item, i) => {
      const label = items.length > 1 ? `Eintrag ${i + 1}: ` : "";
      const type = findType(lk, item.type_id ?? item.typ);
      if (!type) throw new PlanningError(`${label}Event-Typ «${item.type_id ?? item.typ}» nicht gefunden.`);
      const pros = Array.isArray(item.pros)
        ? item.pros.map((p, j) => (p === null || p === undefined || p === "" ? null : requirePro(lk, p, `${label}Termin ${j + 1}: `)))
        : undefined;
      const planned = eventsData.planNew(type, {
        pro_id: requirePro(lk, item.pro_id ?? item.pro, label),
        pros,
        date: item.date ?? item.datum,
        start_min: timeArg(item.start_min ?? item.von),
        end_min: timeArg(item.end_min ?? item.bis),
        notiz: item.notiz,
      });
      await assertArea(db, type, planned.map((ev) => ev.pro_id), label);
      await assertCapacity(db, type, sumBrutto(planned, type), label);
      await assertRules(db, type, planned, [], label);
      for (const ev of planned) {
        await assertFree(db, ev, 0, `${label}${planned.length > 1 ? `Termin ${ev.series_index}: ` : ""}`);
        const { rows } = await db.query(
          `INSERT INTO events (type_id, pro_id, date, start_min, end_min, notiz, series_id, series_index, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${EVENT_FIELDS}, created_at`,
          [ev.type_id, ev.pro_id, ev.date, ev.start_min, ev.end_min, ev.notiz, ev.series_id, ev.series_index, userId]
        );
        created.push(rows[0]);
      }
    });
    return { created, errors, dryRun };
  });
}

// ids: Event-IDs; serie: ganze Serie(n) mitlöschen
async function bulkDelete(ids, { serie = false, dryRun = false } = {}) {
  if (!Array.isArray(ids) || !ids.length) throw new PlanningError("Keine Events angegeben.");
  return transaction(dryRun, "deleted", async (db) => {
    const clean = ids.map((v) => Number.parseInt(v, 10)).filter(Number.isInteger);
    const { rows } = await db.query(
      `DELETE FROM events
        WHERE id = ANY($1::int[])
           OR ($2 AND series_id IN (SELECT series_id FROM events WHERE id = ANY($1::int[]) AND series_id IS NOT NULL))
        RETURNING ${EVENT_FIELDS}, created_by, created_at`,
      [clean, serie]
    );
    const found = new Set(rows.map((r) => r.id));
    const errors = clean.filter((id) => !found.has(id)).map((id) => ({ eintrag: id, fehler: `Event ${id} nicht gefunden.` }));
    return { deleted: rows, errors, dryRun };
  });
}

// changes: [{ event_id, pro?, typ?, datum?, von?, bis?, notiz? }] – fehlende Felder bleiben unverändert
async function bulkUpdate(changes, { dryRun = false } = {}) {
  if (!Array.isArray(changes) || !changes.length) throw new PlanningError("Keine Änderungen angegeben.");
  return transaction(dryRun, "updated", async (db) => {
    const lk = await lookups(db);
    const updated = [];
    const previous = []; // Stand vorher, für «Rückgängig»
    const errors = [];
    await eachItem(db, changes, errors, async (c) => {
      const id = Number.parseInt(c.event_id, 10) || 0;
      const label = `Event ${id}: `;
      const { rows } = await db.query(`SELECT ${EVENT_FIELDS} FROM events WHERE id = $1 FOR UPDATE`, [id]);
      const current = rows[0];
      if (!current) throw new PlanningError(`${label}nicht gefunden.`);
      const type = current.series_id ? lk.types.find((t) => t.id === current.type_id) : findType(lk, c.typ ?? current.type_id);
      if (!type) throw new PlanningError(`${label}Event-Typ «${c.typ}» nicht gefunden.`);
      const has = (v) => v !== null && v !== undefined && v !== "";
      const ev = eventsData.planUpdate(current, type, {
        type_id: type.id,
        pro_id: has(c.pro) ? requirePro(lk, c.pro, label) : current.pro_id,
        date: has(c.datum) ? c.datum : current.date,
        start_min: has(c.von) ? timeArg(c.von) : current.start_min,
        end_min: has(c.bis) ? timeArg(c.bis) : current.end_min,
        notiz: c.notiz ?? current.notiz,
      });
      await assertArea(db, type, [ev.pro_id], label);
      const before = type.id === current.type_id ? minutesOf(current, type, "brutto") : 0;
      await assertCapacity(db, type, minutesOf(ev, type, "brutto") - before, label);
      await assertRules(db, type, [ev], type.id === current.type_id ? [current] : [], label);
      await assertFree(db, ev, id, label);
      const { rows: done } = await db.query(
        `UPDATE events SET type_id = $1, pro_id = $2, date = $3, start_min = $4, end_min = $5, notiz = $6
          WHERE id = $7 RETURNING ${EVENT_FIELDS}`,
        [ev.type_id, ev.pro_id, ev.date, ev.start_min, ev.end_min, ev.notiz, id]
      );
      updated.push(done[0]);
      previous.push(current);
    });
    return { updated, previous, errors, dryRun };
  });
}

// --- Automatisch auslasten ---

// Reihenfolge, die einen Zeitraum gleichmässig abdeckt (statt von vorne aufzufüllen):
// Index i an Position frac(i · goldener Schnitt).
function spreadOrder(n) {
  const phi = (Math.sqrt(5) - 1) / 2;
  return [...Array(n).keys()].sort((a, b) => ((a * phi) % 1) - ((b * phi) % 1));
}

const WEEKDAY_INDEX = Object.fromEntries(eventsData.WEEKDAYS.map((d, i) => [d.toLowerCase(), i]));

// --- Regeln (server/rules.js) ---

async function loadRules(db, { activeOnly = true } = {}) {
  const { rows } = await db.query(
    `SELECT r.id, r.art, r.type_id, r.type_ids, to_char(r.von, 'YYYY-MM-DD') AS von, to_char(r.bis, 'YYYY-MM-DD') AS bis,
            r.operator, r.stunden, r.prozent, r.wochentage, r.aktiv, r.notiz
       FROM rules r ${activeOnly ? "WHERE r.aktiv" : ""} ORDER BY r.art, r.von, r.id`
  );
  return rows;
}

// Brutto-Minuten eines Typs im Zeitraum der Regel (jeder Termin zählt mit seinem Datum)
async function ruleMinutes(db, rule, type) {
  const { rows } = await db.query(
    "SELECT start_min, end_min FROM events WHERE type_id = $1 AND date BETWEEN $2 AND $3",
    [rule.type_id, rule.von, rule.bis]
  );
  return rows.reduce((sum, ev) => sum + minutesOf(ev, type, "brutto"), 0);
}

// Alle Regeln mit aktuellem Stand (für den Reiter «Regeln» und die KI)
async function ruleStatus(db = pool) {
  const lk = await lookups(db);
  const typeById = new Map(lk.types.map((t) => [t.id, t]));
  const list = [];
  const nameOf = (id) => typeById.get(id)?.name;
  for (const rule of await loadRules(db, { activeOnly: false })) {
    if (rule.art === "wochentage") {
      const share = await shareOf(db, rule, typeById);
      list.push({ ...rule, text: rulesData.describe(rule, nameOf), ...share });
      continue;
    }
    const type = typeById.get(rule.type_id);
    const ist = Math.round(((await ruleMinutes(db, rule, type)) / 60) * 100) / 100;
    list.push({
      ...rule,
      typ: type.name,
      typ_code: type.code,
      text: rulesData.describe(rule, nameOf),
      ist_stunden: ist,
      erfuellt: rulesData.OPS[rule.operator].ok(ist, rule.stunden),
    });
  }
  return list;
}

// Anteil der Brutto-Stunden der Regel-Kurse, die an den gewählten Wochentagen liegen.
// Ohne geplante Stunden gilt die Regel als erfüllt.
function shareResult(rule, onMinutes, totalMinutes) {
  const ist = totalMinutes ? Math.round((onMinutes / totalMinutes) * 1000) / 10 : null;
  return {
    ist_prozent: ist,
    stunden_an_tagen: Math.round((onMinutes / 60) * 10) / 10,
    stunden_total: Math.round((totalMinutes / 60) * 10) / 10,
    erfuellt: ist === null || ist >= rule.prozent - rulesData.EPS,
  };
}

async function shareOf(db, rule, typeById) {
  const { rows } = await db.query(
    "SELECT type_id, to_char(date, 'YYYY-MM-DD') AS date, start_min, end_min FROM events WHERE type_id = ANY($1::int[])",
    [rule.type_ids]
  );
  const days = new Set(rule.wochentage);
  let on = 0;
  let total = 0;
  for (const ev of rows) {
    const minutes = minutesOf(ev, typeById.get(ev.type_id), "brutto");
    total += minutes;
    if (days.has(eventsData.weekdayOf(ev.date))) on += minutes;
  }
  return shareResult(rule, on, total);
}

// «R3» oder 3 → 3
function ruleIdOf(value) {
  const n = Number.parseInt(String(value ?? "").replace(/^r/i, ""), 10);
  if (!Number.isInteger(n) || n < 1) throw new PlanningError("Bitte eine Regel-ID angeben, z. B. R3.");
  return n;
}

// Warum ist eine Regel (nicht) erfüllt? Kurze Textzeilen für den Reiter «Regeln» und die KI.
async function diagnoseRule(value, db = pool) {
  const id = ruleIdOf(value);
  const lk = await lookups(db);
  const typeById = new Map(lk.types.map((t) => [t.id, t]));
  const nameOf = (tid) => typeById.get(tid)?.name;
  const rule = (await loadRules(db, { activeOnly: false })).find((r) => r.id === id);
  if (!rule) throw new PlanningError(`Regel R${id} gibt es nicht.`);
  const h = (min) => hoursText(min);
  const lines = [`R${id}: ${rulesData.describe(rule, nameOf)}${rule.aktiv ? "" : " (inaktiv)"}`];
  const { rows: events } = await db.query(`SELECT ${EVENT_FIELDS} FROM events`);
  const proName = new Map(lk.pros.map((p) => [p.id, p.name]));
  const byPro = (list, type) => {
    const sums = new Map();
    for (const ev of list) sums.set(ev.pro_id, (sums.get(ev.pro_id) || 0) + minutesOf(ev, type || typeById.get(ev.type_id), "brutto"));
    return [...sums].sort((a, b) => b[1] - a[1]).map(([pid, m]) => `${proName.get(pid)} ${h(m)}`).join(", ") || "niemand";
  };

  if (rule.art === "wochentage") {
    const days = new Set(rule.wochentage);
    let on = 0;
    let total = 0;
    for (const tid of rule.type_ids) {
      const type = typeById.get(tid);
      if (!type) continue;
      const list = events.filter((ev) => ev.type_id === tid);
      const tOn = list.filter((ev) => days.has(eventsData.weekdayOf(ev.date))).reduce((s, ev) => s + minutesOf(ev, type, "brutto"), 0);
      const tTotal = list.reduce((s, ev) => s + minutesOf(ev, type, "brutto"), 0);
      on += tOn;
      total += tTotal;
      // Liegen alle Termine des Kurses fest an Tagen ausserhalb der Auswahl?
      const fixedDays = type.first_weekday === null ? null : type.series_offsets.map((o) => (type.first_weekday + o) % 7);
      const never = fixedDays && fixedDays.every((d) => !days.has(d));
      const always = fixedDays && fixedDays.every((d) => days.has(d));
      lines.push(`${type.code || type.name}: ${h(tOn)} von ${h(tTotal)} an den gewählten Tagen${never ? " – findet nie an diesen Tagen statt (zählt nur dagegen)" : always ? " – findet immer an diesen Tagen statt" : ""}`);
    }
    const share = shareResult(rule, on, total);
    if (share.ist_prozent === null) {
      lines.push("Stand: noch keine Stunden dieser Kurse geplant – die Regel gilt als erfüllt.");
    } else if (share.erfuellt) {
      lines.push(`Stand: ${share.ist_prozent} % (mind. ${rule.prozent} %) – erfüllt.`);
    } else {
      const p = rule.prozent / 100;
      const addOn = p < 1 ? (p * total - on) / (1 - p) : Infinity;
      const removeOff = total - on / p; // so viel an anderen Tagen weniger, damit on / total = p
      lines.push(`Stand: ${share.ist_prozent} % (mind. ${rule.prozent} %) – nicht erfüllt.`);
      lines.push(`Lösung: ${Number.isFinite(addOn) ? `zusätzlich ${h(addOn)} an den gewählten Tagen einplanen oder ` : ""}${h(Math.max(0, removeOff))} an anderen Tagen streichen bzw. verschieben.`);
    }
    return lines;
  }

  const type = typeById.get(rule.type_id);
  const inWindow = events.filter((ev) => ev.type_id === type.id && ev.date >= rule.von && ev.date <= rule.bis);
  const ist = inWindow.reduce((s, ev) => s + minutesOf(ev, type, "brutto"), 0);
  const target = rule.stunden * 60;
  const ok = rulesData.OPS[rule.operator].ok(ist / 60, rule.stunden);
  lines.push(`Stand: ${h(ist)} (Ziel: ${rulesData.OPS[rule.operator].label} ${rule.stunden} h) – ${ok ? "erfüllt" : "nicht erfüllt"}.`);
  lines.push(`Verteilung im Zeitraum: ${byPro(inWindow, type)}.`);
  if (ok) return lines;
  if (rulesData.OPS[rule.operator].upper && ist > target) {
    lines.push(`Grund: ${h(ist - target)} zu viel geplant. Lösung: Termine in diesem Zeitraum löschen oder verschieben.`);
    return lines;
  }

  // Untergrenze nicht erreicht: was hindert das Auffüllen?
  lines.push(`Es fehlen ${h(target - ist)}${rule.operator === "gt" ? " (plus etwas mehr, da «mehr als»)" : ""}.`);
  if (type.fixed_start_min === null) {
    lines.push("Grund: Der Kurs hat keine feste Zeit; «Auslasten» kann ihn nicht automatisch einplanen. Lösung: von Hand oder per KI einplanen.");
  }
  const from = type.einplanbar_von && type.einplanbar_von > rule.von ? type.einplanbar_von : rule.von;
  const to = type.einplanbar_bis && type.einplanbar_bis < rule.bis ? type.einplanbar_bis : rule.bis;
  if (type.einplanbar_von || type.einplanbar_bis) lines.push(`Einplanbar laut Kurs: ${type.einplanbar_von || "…"} bis ${type.einplanbar_bis || "…"} (Schnitt mit der Regel: ${from} bis ${to}).`);
  if (type.max_stunden) {
    const used = events.filter((ev) => ev.type_id === type.id).reduce((s, ev) => s + minutesOf(ev, type, "brutto"), 0);
    lines.push(`Kurs-Maximum: ${h(used)} von ${type.max_stunden} h verbraucht${used >= type.max_stunden * 60 - 1 ? " – erreicht, das blockiert weitere Termine" : ""}.`);
  }
  for (const other of (await loadRules(db)).filter((r) => r.art === "stunden" && r.id !== rule.id && r.type_id === type.id && rulesData.OPS[r.operator].upper)) {
    if (other.von <= rule.bis && other.bis >= rule.von) {
      lines.push(`Achtung: R${other.id} (${rulesData.describe(other, nameOf)}) begrenzt denselben Kurs im überlappenden Zeitraum.`);
    }
  }
  const area = eventsData.AREAS[type.einsatzbereich];
  const pros = lk.pros.filter((p) => p.sollstunden > 0 && areaAllows(type, p));
  lines.push(`Pros im Einsatzbereich ${area?.label || "alle"}: ${pros.map((p) => p.name).join(", ") || "keine – deshalb kann niemand den Kurs übernehmen"}.`);
  if (!pros.length || type.fixed_start_min === null) return lines;

  // Mögliche Starttage und freie Pros
  const busy = new Map();
  for (const ev of events) {
    const key = `${ev.pro_id}|${ev.date}`;
    busy.set(key, [...(busy.get(key) || []), [ev.start_min, ev.end_min]]);
  }
  const isFree = (ev) => !(busy.get(`${ev.pro_id}|${ev.date}`) || []).some(([a, b]) => ev.start_min < b && ev.end_min > a);
  const last = type.series_offsets[type.series_offsets.length - 1];
  let starts = 0;
  let seriesHours = 0;
  let withPro = 0;
  let withProFreeDays = 0;
  for (let d = from; d <= to; d = eventsData.addDays(d, 1)) {
    if (type.first_weekday !== null && eventsData.weekdayOf(d) !== type.first_weekday) continue;
    if (eventsData.addDays(d, last) > to) break;
    if (!starts++) seriesHours = eventsData.planNew(type, { pro_id: pros[0].id, date: d }).reduce((s, ev) => s + minutesOf(ev, type, "brutto"), 0);
    let any = false;
    let anyFreeDays = false;
    for (const pro of pros) {
      const series = eventsData.planNew(type, { pro_id: pro.id, date: d });
      if (!series.every(isFree)) continue;
      any = true;
      const off = new Set((pro.freie_tage || []).map((x) => WEEKDAY_INDEX[String(x).toLowerCase()]));
      if (!series.some((ev) => off.has(eventsData.weekdayOf(ev.date)))) anyFreeDays = true;
    }
    if (any) withPro++;
    if (anyFreeDays) withProFreeDays++;
  }
  if (!starts) {
    lines.push(`Grund: Keine Serie passt ganz in den Zeitraum (eine Serie dauert ${last + 1} Tage${type.first_weekday !== null ? ` und beginnt immer am ${eventsData.WEEKDAYS[type.first_weekday]}` : ""}).`);
    return lines;
  }
  lines.push(`Mögliche Starttage: ${starts}; davon mit mindestens einem freien Pro: ${withPro}, unter Beachtung der freien Tage: ${withProFreeDays} (je Serie ${h(seriesHours)}).`);
  const possible = withPro * seriesHours;
  lines.push(possible >= target - ist
    ? "Es gibt genug Platz: «Auslasten» mit «Regeln zuerst erfüllen» kann die Regel erfüllen (ggf. «Freie Tage beachten» ausschalten)."
    : `Grund: Selbst alle freien Starttage ergeben nur ${h(possible)} – die Pros sind zu dieser Zeit schon belegt. Lösung: Zeitraum vergrössern, Termine verschieben oder mehr Pros für ${area?.label || "den Kurs"} freigeben.`);
  return lines;
}

// Obergrenzen (genau, höchstens) dürfen durch neue Termine nicht überschritten werden.
// added/removed: Events mit date, start_min, end_min (bei Änderungen der alte Stand in removed).
async function assertRules(db, type, added, removed = [], label = "") {
  const rules = (await loadRules(db)).filter((r) => r.art === "stunden" && r.type_id === type.id && rulesData.OPS[r.operator].upper);
  for (const rule of rules) {
    const inWindow = (list) => list.filter((ev) => ev.date >= rule.von && ev.date <= rule.bis)
      .reduce((sum, ev) => sum + minutesOf(ev, type, "brutto"), 0);
    const delta = inWindow(added) - inWindow(removed);
    if (delta <= 0) continue;
    const now = await ruleMinutes(db, rule, type);
    if ((now + delta) / 60 > rule.stunden + rulesData.EPS) {
      throw new eventsData.ValidationError(
        `${label}Regel verletzt: «${rulesData.describe(rule, () => type.name)}» – bereits ${hoursText(now)} geplant, dazu kämen ${hoursText(delta)}.`
      );
    }
  }
}

// Plant für jeden Pro Serien der gewählten Typen, bis die Ziel-Auslastung (brutto in % der Sollstunden,
// gezählt wie in der Übersicht über alle Events) erreicht ist. Die Serien werden gleichmässig über den
// Zeitraum verteilt; es gelten die Regeln des Tools (keine Überschneidung, Wochentag, feste Zeit, Einsatzbereich,
// Typ-Maximum) und die aktiven Regeln, auf Wunsch zusätzlich die freien Wochentage der Pros.
// Ganz oder gar nicht, eine Transaktion.
// ziele: [{ pro, prozent }] = eigenes Ziel je Pro (statt ziel_prozent für alle bzw. die Liste pros).
// regeln_erfuellen: zuerst die Untergrenzen der aktiven Regeln (mindestens, genau, mehr als) auffüllen,
// verteilt auf passende Pros mit der geringsten Auslastung im Verhältnis zu ihrem Ziel.
async function autoFill(
  { pros, ziel_prozent, ziele, typen, von, bis, freie_tage_beachten = false, regeln_erfuellen = false } = {},
  { dryRun = false, userId = null } = {}
) {
  const checkPercent = (v) => {
    const n = Number(v);
    if (!(n >= 0 && n <= 200)) throw new PlanningError("Ziel-Auslastung: bitte eine Zahl zwischen 0 und 200 (%).");
    return n;
  };
  if (!ziele?.length) checkPercent(ziel_prozent);
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
  const from = isDate(von) ? von : "2027-01-01";
  const to = isDate(bis) ? bis : "2027-12-31";
  if (to < from) throw new PlanningError("Zeitraum: «bis» liegt vor «von».");

  return transaction(dryRun, "created", async (db) => {
    const lk = await lookups(db);
    const typeById = new Map(lk.types.map((t) => [t.id, t]));
    const requirePro = (p) => findPro(lk, p) || (() => { throw new PlanningError(`Pro «${p}» nicht gefunden.`); })();
    const targets = ziele?.length
      ? ziele.map((z) => ({ pro: requirePro(z.pro), percent: checkPercent(z.prozent) }))
      : (pros?.length ? pros.map(requirePro) : lk.pros.filter((p) => p.sollstunden > 0))
          .map((pro) => ({ pro, percent: Number(ziel_prozent) }));
    const types = typen?.length
      ? typen.map((t) => findType(lk, t) || (() => { throw new PlanningError(`Event-Typ «${t}» nicht gefunden.`); })())
      : lk.types.filter((t) => t.fixed_start_min !== null);
    for (const t of types) {
      if (t.fixed_start_min === null) throw new PlanningError(`«${t.name}» hat keine feste Zeit und lässt sich nicht automatisch verteilen.`);
    }
    if (!types.length && !regeln_erfuellen) throw new PlanningError("Keine Event-Typen mit fester Zeit vorhanden.");

    // Mögliche Starttage eines Typs (ganze Serie im Zeitraum und im einplanbaren Zeitraum des Typs),
    // in einer Reihenfolge, die den Zeitraum gleichmässig abdeckt.
    function candidatesFor(t, rangeFrom, rangeTo) {
      const last = t.series_offsets[t.series_offsets.length - 1];
      const start = t.einplanbar_von && t.einplanbar_von > rangeFrom ? t.einplanbar_von : rangeFrom;
      const end = t.einplanbar_bis && t.einplanbar_bis < rangeTo ? t.einplanbar_bis : rangeTo;
      const list = [];
      for (let d = start; d <= end; d = eventsData.addDays(d, 1)) {
        if (t.first_weekday !== null && eventsData.weekdayOf(d) !== t.first_weekday) continue;
        if (eventsData.addDays(d, last) > end) break;
        list.push({ type: t, date: d });
      }
      return list;
    }
    const spread = (list) => spreadOrder(list.length).map((i) => list[i]);

    // Bestehende Belegung, geplante Stunden je Pro, verbrauchte Stunden je Typ und je Regel
    const { rows: existing } = await db.query(`SELECT ${EVENT_FIELDS} FROM events`);
    const busy = new Map(); // "pro|datum" → [[Beginn, Ende]]
    const planned = new Map();
    const typeUsed = new Map();
    const book = (ev) => {
      const key = `${ev.pro_id}|${ev.date}`;
      busy.set(key, [...(busy.get(key) || []), [ev.start_min, ev.end_min]]);
    };
    for (const ev of existing) {
      const minutes = minutesOf(ev, typeById.get(ev.type_id), "brutto");
      book(ev);
      planned.set(ev.pro_id, (planned.get(ev.pro_id) || 0) + minutes);
      typeUsed.set(ev.type_id, (typeUsed.get(ev.type_id) || 0) + minutes);
    }
    const allRules = await loadRules(db);
    const nameOf = (id) => typeById.get(id)?.name;
    const rules = allRules.filter((r) => r.art === "stunden").map((r) => ({ ...r, type: typeById.get(r.type_id) }));
    // Anteil-Regeln (Wochentage): Brutto-Minuten an den gewählten Tagen und insgesamt
    const shareRules = allRules.filter((r) => r.art === "wochentage")
      .map((r) => ({ ...r, ids: new Set(r.type_ids), days: new Set(r.wochentage), on: 0, total: 0 }));
    const shareAdd = (rule, list) => {
      let on = 0;
      let total = 0;
      for (const ev of list) {
        if (!rule.ids.has(ev.type_id)) continue;
        const minutes = minutesOf(ev, typeById.get(ev.type_id), "brutto");
        total += minutes;
        if (rule.days.has(eventsData.weekdayOf(ev.date))) on += minutes;
      }
      return { on, total };
    };
    for (const rule of shareRules) Object.assign(rule, shareAdd(rule, existing), { before: shareAdd(rule, existing) });
    const ruleUsed = new Map();
    const inRule = (rule, ev) => ev.type_id === rule.type_id && ev.date >= rule.von && ev.date <= rule.bis;
    for (const rule of rules) {
      ruleUsed.set(rule.id, existing.filter((ev) => inRule(rule, ev)).reduce((s, ev) => s + minutesOf(ev, rule.type, "brutto"), 0));
    }
    const rulesBefore = new Map(ruleUsed);

    const freeDaysOf = (pro) => freie_tage_beachten
      ? new Set((pro.freie_tage || []).map((d) => WEEKDAY_INDEX[String(d).toLowerCase()]))
      : new Set();
    const free = (ev) => !(busy.get(`${ev.pro_id}|${ev.date}`) || []).some(([s, e]) => ev.start_min < e && ev.end_min > s);
    const seriesMinutes = (type, series) => series.reduce((sum, ev) => sum + minutesOf(ev, type, "brutto"), 0);

    // Darf diese Serie so eingeplant werden? (Einsatzbereich, frei, freie Tage, Typ-Maximum, Regel-Obergrenzen)
    function fits(type, series, pro) {
      if (!areaAllows(type, pro)) return false;
      const freeDays = freeDaysOf(pro);
      if (series.some((ev) => freeDays.has(eventsData.weekdayOf(ev.date)) || !free(ev))) return false;
      if (type.max_stunden && (typeUsed.get(type.id) || 0) + seriesMinutes(type, series) > type.max_stunden * 60 + 0.01) return false;
      for (const rule of rules) {
        if (!rulesData.OPS[rule.operator].upper) continue;
        const add = series.filter((ev) => inRule(rule, ev)).reduce((s, ev) => s + minutesOf(ev, type, "brutto"), 0);
        if (add && (ruleUsed.get(rule.id) + add) / 60 > rule.stunden + rulesData.EPS) return false;
      }
      // Termine an anderen Tagen nur, solange der Anteil an den gewählten Tagen nicht unter das Minimum fällt
      for (const rule of shareRules) {
        const add = shareAdd(rule, series);
        if (add.on >= add.total) continue;
        const total = rule.total + add.total;
        if (total && ((rule.on + add.on) / total) * 100 < rule.prozent - rulesData.EPS) return false;
      }
      return true;
    }

    const toInsert = [];
    const perPro = new Map(); // Pro-ID → Map(Typ → Anzahl Serien)
    function commit(type, series, pro) {
      const minutes = seriesMinutes(type, series);
      for (const ev of series) {
        book(ev);
        toInsert.push(ev);
        for (const rule of rules) {
          if (inRule(rule, ev)) ruleUsed.set(rule.id, ruleUsed.get(rule.id) + minutesOf(ev, type, "brutto"));
        }
      }
      for (const rule of shareRules) {
        const add = shareAdd(rule, series);
        rule.on += add.on;
        rule.total += add.total;
      }
      planned.set(pro.id, (planned.get(pro.id) || 0) + minutes);
      typeUsed.set(type.id, (typeUsed.get(type.id) || 0) + minutes);
      const counts = perPro.get(pro.id) || new Map();
      counts.set(type.code || type.name, (counts.get(type.code || type.name) || 0) + 1);
      perPro.set(pro.id, counts);
    }

    const goalOf = new Map(targets.map(({ pro, percent }) => [pro.id, (pro.sollstunden * 60 * percent) / 100]));
    const before = new Map(lk.pros.map((p) => [p.id, planned.get(p.id) || 0]));

    // 1) Regeln erfüllen (Untergrenzen)
    if (regeln_erfuellen) {
      for (const rule of rules) {
        const op = rule.operator;
        if (op === "max" || rule.type.fixed_start_min === null) continue;
        const target = rule.stunden * 60;
        // erreicht: «mehr als» erst über dem Wert, «mindestens»/«genau» ab dem Wert
        const done = () => {
          const h = ruleUsed.get(rule.id) / 60;
          return op === "gt" ? h > rule.stunden + rulesData.EPS : h >= rule.stunden - rulesData.EPS;
        };
        const rangeFrom = rule.von > from ? rule.von : from;
        const rangeTo = rule.bis < to ? rule.bis : to;
        for (const { type, date } of spread(candidatesFor(rule.type, rangeFrom, rangeTo))) {
          if (done()) break;
          const minutes = seriesMinutes(type, eventsData.planNew(type, { pro_id: 1, date })); // unabhängig vom Pro
          if (op === "eq" && ruleUsed.get(rule.id) + minutes > target + 0.6) continue; // «genau» nicht überschreiten
          // Pros mit der geringsten Auslastung im Verhältnis zu ihrem Ziel zuerst
          const ranked = lk.pros
            .filter((p) => p.sollstunden > 0)
            .sort((a, b) => (planned.get(a.id) || 0) / (goalOf.get(a.id) || a.sollstunden * 60 || 1)
              - (planned.get(b.id) || 0) / (goalOf.get(b.id) || b.sollstunden * 60 || 1));
          for (const pro of ranked) {
            const series = eventsData.planNew(type, { pro_id: pro.id, date });
            if (!fits(type, series, pro)) continue;
            commit(type, series, pro);
            break;
          }
        }
      }
    }

    // 2) Ziel-Auslastung je Pro auffüllen
    const candidates = types.flatMap((t) => candidatesFor(t, from, to))
      .sort((a, b) => a.date.localeCompare(b.date) || a.type.id - b.type.id);
    const ordered = spread(candidates);
    const summary = [];
    for (const { pro } of targets) {
      if (!pro.sollstunden) {
        summary.push({ pro: pro.name, hinweis: "keine Sollstunden" });
        continue;
      }
      const goal = goalOf.get(pro.id);
      const hasTypes = types.some((t) => areaAllows(t, pro));
      for (const { type, date } of hasTypes ? ordered : []) {
        const have = planned.get(pro.id) || 0;
        if (have >= goal) break;
        const series = eventsData.planNew(type, { pro_id: pro.id, date });
        const minutes = seriesMinutes(type, series);
        if (have + minutes > goal + minutes / 2) continue; // nicht deutlich übers Ziel
        if (!fits(type, series, pro)) continue;
        commit(type, series, pro);
      }
      const have = planned.get(pro.id) || 0;
      summary.push({
        pro: pro.name,
        vorher_prozent: Math.round((before.get(pro.id) / 60 / pro.sollstunden) * 1000) / 10,
        nachher_prozent: Math.round((have / 60 / pro.sollstunden) * 1000) / 10,
        serien: Object.fromEntries(perPro.get(pro.id) || []),
        ...(!hasTypes && !perPro.has(pro.id) ? { hinweis: "keine passenden Typen für den Einsatzbereich" }
          : have < goal * 0.95 ? { hinweis: "Ziel nicht erreicht (zu wenig freie Termine)" } : {}),
      });
    }

    const hoursOf = (min) => `${Math.round((min / 60) * 100) / 100} h`;
    const percentOf = (r) => (r.total ? `${Math.round((r.on / r.total) * 1000) / 10} %` : "–");
    const regeln = [
      ...rules.map((rule) => {
        const ist = Math.round((ruleUsed.get(rule.id) / 60) * 100) / 100;
        return {
          id: `R${rule.id}`,
          regel: rulesData.describe(rule, nameOf),
          vorher: hoursOf(rulesBefore.get(rule.id)),
          nachher: hoursOf(ruleUsed.get(rule.id)),
          erfuellt: rulesData.OPS[rule.operator].ok(ist, rule.stunden),
        };
      }),
      ...shareRules.map((rule) => ({
        id: `R${rule.id}`,
        regel: rulesData.describe(rule, nameOf),
        vorher: percentOf(rule.before),
        nachher: percentOf(rule),
        erfuellt: shareResult(rule, rule.on, rule.total).erfuellt,
      })),
    ];

    let created = [];
    if (toInsert.length) {
      const col = (key) => toInsert.map((ev) => ev[key]);
      ({ rows: created } = await db.query(
        `INSERT INTO events (type_id, pro_id, date, start_min, end_min, notiz, series_id, series_index, created_by)
         SELECT * FROM unnest($1::int[], $2::int[], $3::date[], $4::int[], $5::int[], $6::text[], $7::text[], $8::int[], $9::int[])
         RETURNING ${EVENT_FIELDS}, created_at`,
        [col("type_id"), col("pro_id"), col("date"), col("start_min"), col("end_min"), col("notiz"),
          col("series_id"), col("series_index"), toInsert.map(() => userId)]
      ));
    }
    return { created, errors: [], dryRun, summary, regeln };
  });
}

// Nimmt genau eine Sammel-Aktion zurück, ohne andere Daten zu berühren:
// undo = { created: [{ id, created_at }] } | { deleted: [Zeilen] } | { updated: [Zeilen vorher] }.
// Angelegte Events werden nur gelöscht, wenn auch der Erstellungszeitpunkt passt
// (nach einer Wiederherstellung können IDs neu vergeben werden).
// Ganz oder gar nicht; Konflikte (z. B. Überschneidung mit neueren Events) kommen als errors zurück.
async function undoChange(undo) {
  return transaction(false, "done", async (db) => {
    const errors = [];
    let done = 0;
    if (undo.created?.length) {
      const { rowCount } = await db.query(
        `DELETE FROM events e USING unnest($1::int[], $2::timestamptz[]) AS u(id, created_at)
          WHERE e.id = u.id AND date_trunc('milliseconds', e.created_at) = u.created_at`,
        [undo.created.map((c) => c.id), undo.created.map((c) => c.created_at)]
      );
      done += rowCount;
    }
    await eachItem(db, undo.deleted || [], errors, async (row) => {
      const label = `Event ${row.id} (${formatDate(row.date)}): `;
      const { rows } = await db.query("SELECT 1 FROM events WHERE id = $1", [row.id]);
      if (rows.length) throw new PlanningError(`${label}existiert bereits wieder.`);
      await assertFree(db, row, row.id, label);
      try {
        await db.query(
          `INSERT INTO events (id, type_id, pro_id, date, start_min, end_min, notiz, series_id, series_index, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (SELECT id FROM users WHERE id = $10), coalesce($11, now()))`,
          [row.id, row.type_id, row.pro_id, row.date, row.start_min, row.end_min, row.notiz, row.series_id, row.series_index,
            row.created_by ?? null, row.created_at ?? null]
        );
      } catch (err) {
        if (err.code === "23503") throw new PlanningError(`${label}Pro oder Event-Typ gibt es nicht mehr.`);
        throw err;
      }
      done++;
    });
    await eachItem(db, undo.updated || [], errors, async (row) => {
      const label = `Event ${row.id}: `;
      const { rows } = await db.query("SELECT 1 FROM events WHERE id = $1 FOR UPDATE", [row.id]);
      if (!rows.length) throw new PlanningError(`${label}wurde inzwischen gelöscht.`);
      await assertFree(db, row, row.id, label);
      try {
        await db.query(
          "UPDATE events SET type_id = $1, pro_id = $2, date = $3, start_min = $4, end_min = $5, notiz = $6 WHERE id = $7",
          [row.type_id, row.pro_id, row.date, row.start_min, row.end_min, row.notiz, row.id]
        );
      } catch (err) {
        if (err.code === "23503") throw new PlanningError(`${label}Pro oder Event-Typ gibt es nicht mehr.`);
        throw err;
      }
      done++;
    });
    return { done, errors };
  });
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

module.exports = {
  TYPE_FIELDS, EVENT_FIELDS, PlanningError,
  loadType, assertFree, assertArea, assertCapacity, assertRules, ruleStatus, diagnoseRule, formatDate, clock, timeArg, minutesOf,
  overview, overviewText, bulkCreate, bulkDelete, bulkUpdate, autoFill, undoChange, describeEvents,
};
