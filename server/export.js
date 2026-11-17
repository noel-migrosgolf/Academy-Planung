// Export eines Plans als Excel (.xlsx), PDF oder JSON (GET /api/plan-export).
// Alle drei Formate entstehen aus denselben Daten (collect): Kurse (Termine) im Zeitraum, wahlweise nur
// eines Pros, dazu die Kursanzahl je Kurstyp, die Auslastung der Pros und der Stand der Regeln.

const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const { pool } = require("./db");
const eventsData = require("./events");
const planning = require("./planning");

const YEAR_FROM = "2027-01-01";
const YEAR_TO = "2027-12-31";

const hours = (min) => Math.round((min / 60) * 100) / 100;
const { clock, formatDate, minutesOf } = planning;

// ISO-Kalenderwoche eines Datums «YYYY-MM-DD»
function isoWeek(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // Donnerstag derselben Woche
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// Daten des Exports. from/to: Zeitraum (Standard: ganzes Jahr 2027); proId: nur Kurse dieses Pros.
async function collect(plan, { from = YEAR_FROM, to = YEAR_TO, proId = null } = {}) {
  const [prosRes, typesRes, eventsRes, regeln] = await Promise.all([
    pool.query("SELECT id, code, name, sollstunden, auslastung_soll_prozent FROM pros ORDER BY sort_order, id"),
    pool.query(`SELECT ${planning.TYPE_FIELDS} FROM event_types ORDER BY sort_order, id`),
    pool.query(`SELECT ${planning.EVENT_FIELDS} FROM events WHERE plan_id = $1 ORDER BY date, start_min, id`, [plan.id]),
    planning.ruleStatus(plan.id),
  ]);
  const pros = prosRes.rows;
  const types = typesRes.rows;
  const all = eventsRes.rows;
  const typeById = new Map(types.map((t) => [t.id, t]));
  const proById = new Map(pros.map((p) => [p.id, p]));
  const filterPro = proId ? proById.get(proId) : null;
  if (proId && !filterPro) throw new eventsData.ValidationError("Pro nicht gefunden.");

  const seriesSize = new Map();
  for (const ev of all) if (ev.series_id) seriesSize.set(ev.series_id, (seriesSize.get(ev.series_id) || 0) + 1);

  const inRange = all.filter((ev) => ev.date >= from && ev.date <= to && (!filterPro || ev.pro_id === filterPro.id));
  const courseKey = (ev) => ev.series_id || `e${ev.id}`;

  const kurse = inRange.map((ev) => {
    const t = typeById.get(ev.type_id);
    const pro = proById.get(ev.pro_id);
    const netto = minutesOf(ev, t, "netto");
    return {
      id: ev.id,
      datum: ev.date,
      wochentag: eventsData.WEEKDAYS[eventsData.weekdayOf(ev.date)],
      kw: isoWeek(ev.date),
      beginn: clock(ev.start_min),
      unterricht_bis: clock(Math.min(ev.end_min, ev.start_min + Math.round(netto))),
      belegt_bis: clock(ev.end_min),
      pro: pro?.name ?? "?",
      pro_kuerzel: pro?.code ?? null,
      kurstyp_id: t?.code ?? null,
      kurstyp: t?.name ?? "?",
      kurs_nr: ev.kurs_nr,
      kurs: `${t?.name ?? "?"}${ev.kurs_nr ? ` (${ev.kurs_nr})` : ""}${ev.series_id ? ` – ${ev.series_index}/${seriesSize.get(ev.series_id)}` : ""}`,
      bereich: eventsData.AREAS[t?.einsatzbereich]?.label || "alle",
      serie: ev.series_id ? `${ev.series_index}/${seriesSize.get(ev.series_id)}` : null,
      serie_id: ev.series_id,
      brutto_h: hours(minutesOf(ev, t, "brutto")),
      netto_h: hours(netto),
      notiz: ev.notiz || null,
    };
  });

  // Kursanzahl je Kurstyp im Zeitraum: Kurse = Serien bzw. Einzeltermine
  const kurstypen = [];
  for (const t of types) {
    const list = inRange.filter((ev) => ev.type_id === t.id);
    if (!list.length) continue;
    const courses = new Map(); // Kurs → Pro des ersten Termins
    for (const ev of [...list].sort((a, b) => (a.series_index || 0) - (b.series_index || 0))) {
      if (!courses.has(courseKey(ev))) courses.set(courseKey(ev), ev.pro_id);
    }
    const perPro = new Map();
    for (const pid of courses.values()) perPro.set(pid, (perPro.get(pid) || 0) + 1);
    kurstypen.push({
      id: t.code,
      name: t.name,
      bereich: eventsData.AREAS[t.einsatzbereich]?.label || "alle",
      kurse: courses.size,
      termine: list.length,
      brutto_h: hours(list.reduce((s, ev) => s + minutesOf(ev, t, "brutto"), 0)),
      netto_h: hours(list.reduce((s, ev) => s + minutesOf(ev, t, "netto"), 0)),
      max_stunden: t.max_stunden,
      pros: [...perPro].sort((a, b) => b[1] - a[1]).map(([pid, n]) => ({ pro: proById.get(pid)?.name ?? "?", kurse: n })),
    });
  }

  // Pros: Stunden im Zeitraum und Auslastung übers ganze Jahr 2027 (wie in der App)
  const proRows = (filterPro ? [filterPro] : pros).map((p) => {
    const own = inRange.filter((ev) => ev.pro_id === p.id);
    const sum = (list, mode) => list.reduce((s, ev) => s + minutesOf(ev, typeById.get(ev.type_id), mode), 0);
    const year = all.filter((ev) => ev.pro_id === p.id && ev.date >= YEAR_FROM && ev.date <= YEAR_TO);
    return {
      name: p.name,
      kuerzel: p.code,
      sollstunden: p.sollstunden,
      ziel_prozent: p.auslastung_soll_prozent,
      kurse: new Set(own.map(courseKey)).size,
      termine: own.length,
      brutto_h: hours(sum(own, "brutto")),
      netto_h: hours(sum(own, "netto")),
      jahr_brutto_h: hours(sum(year, "brutto")),
      auslastung_prozent: p.sollstunden ? Math.round((sum(year, "brutto") / 60 / p.sollstunden) * 1000) / 10 : null,
    };
  });

  return {
    plan: { id: plan.id, name: plan.name, besitzer: plan.owner ?? null },
    exportiert_am: new Date().toISOString(),
    zeitraum: { von: from, bis: to },
    pro: filterPro ? filterPro.name : null,
    summe: {
      kurse: new Set(inRange.map(courseKey)).size,
      termine: kurse.length,
      brutto_h: hours(inRange.reduce((s, ev) => s + minutesOf(ev, typeById.get(ev.type_id), "brutto"), 0)),
      netto_h: hours(inRange.reduce((s, ev) => s + minutesOf(ev, typeById.get(ev.type_id), "netto"), 0)),
    },
    pros: proRows,
    kurstypen,
    kurse,
    regeln: regeln.filter((r) => r.aktiv).map((r) => ({ id: `R${r.id}`, regel: r.text, erfuellt: r.erfuellt })),
  };
}

const stamp = (iso) => new Date(iso).toLocaleString("de-CH", { timeZone: "Europe/Zurich", dateStyle: "medium", timeStyle: "short" });
const proText = (list) => list.map((p) => `${p.pro} ${p.kurse}`).join(", ");

// --- Excel ---

function addSheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.numFmt ? { numFmt: c.numFmt } : {} }));
  ws.addRows(rows);
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3A2E" } };
  head.alignment = { vertical: "middle" };
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

async function toXlsx(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AI Academy Golf – Planungstool";
  wb.created = new Date();
  const day = (iso) => new Date(`${iso}T00:00:00Z`);

  addSheet(wb, "Kurse", [
    { header: "Datum", key: "datum", width: 12, numFmt: "dd.mm.yyyy" },
    { header: "Tag", key: "tag", width: 6 },
    { header: "KW", key: "kw", width: 6 },
    { header: "Beginn", key: "beginn", width: 8 },
    { header: "Unterricht bis", key: "unterricht_bis", width: 14 },
    { header: "Belegt bis", key: "belegt_bis", width: 10 },
    { header: "Pro", key: "pro", width: 16 },
    { header: "Kürzel", key: "pro_kuerzel", width: 8 },
    { header: "Kurstyp-ID", key: "kurstyp_id", width: 12 },
    { header: "Kurstyp", key: "kurstyp", width: 30 },
    { header: "Kurs-Nr.", key: "kurs_nr", width: 9 },
    { header: "Termin", key: "serie", width: 8 },
    { header: "Kurs", key: "kurs", width: 40 },
    { header: "Bereich", key: "bereich", width: 10 },
    { header: "Brutto h", key: "brutto_h", width: 10, numFmt: "0.00" },
    { header: "Netto h", key: "netto_h", width: 10, numFmt: "0.00" },
    { header: "Notiz", key: "notiz", width: 40 },
  ], data.kurse.map((k) => ({ ...k, datum: day(k.datum), tag: k.wochentag.slice(0, 2) })));

  addSheet(wb, "Kursanzahl", [
    { header: "Kurstyp-ID", key: "id", width: 12 },
    { header: "Kurstyp", key: "name", width: 34 },
    { header: "Bereich", key: "bereich", width: 10 },
    { header: "Kurse", key: "kurse", width: 8 },
    { header: "Termine", key: "termine", width: 9 },
    { header: "Brutto h", key: "brutto_h", width: 10, numFmt: "0.00" },
    { header: "Netto h", key: "netto_h", width: 10, numFmt: "0.00" },
    { header: "Max. Sollstd.", key: "max_stunden", width: 13 },
    { header: "Pros (Kurse)", key: "pros", width: 60 },
  ], data.kurstypen.map((t) => ({ ...t, pros: proText(t.pros) })));

  addSheet(wb, "Pros", [
    { header: "Pro", key: "name", width: 18 },
    { header: "Kürzel", key: "kuerzel", width: 8 },
    { header: "Kurse", key: "kurse", width: 8 },
    { header: "Termine", key: "termine", width: 9 },
    { header: "Brutto h (Zeitraum)", key: "brutto_h", width: 19, numFmt: "0.00" },
    { header: "Netto h (Zeitraum)", key: "netto_h", width: 18, numFmt: "0.00" },
    { header: "Sollstunden", key: "sollstunden", width: 12 },
    { header: "Brutto h 2027", key: "jahr_brutto_h", width: 14, numFmt: "0.00" },
    { header: "Auslastung 2027 %", key: "auslastung_prozent", width: 18, numFmt: "0.0" },
    { header: "Ziel %", key: "ziel_prozent", width: 8 },
  ], data.pros);

  addSheet(wb, "Regeln", [
    { header: "ID", key: "id", width: 6 },
    { header: "Regel", key: "regel", width: 110 },
    { header: "Erfüllt", key: "erfuellt", width: 9 },
  ], data.regeln.map((r) => ({ ...r, erfuellt: r.erfuellt ? "ja" : "nein" })));

  const info = wb.addWorksheet("Info");
  info.columns = [{ width: 18 }, { width: 50 }];
  info.addRows([
    ["Plan", data.plan.name],
    ["Besitzer", data.plan.besitzer || ""],
    ["Zeitraum", `${formatDate(data.zeitraum.von)} – ${formatDate(data.zeitraum.bis)}`],
    ["Pro", data.pro || "alle"],
    ["Kurse", data.summe.kurse],
    ["Termine", data.summe.termine],
    ["Brutto h", data.summe.brutto_h],
    ["Netto h", data.summe.netto_h],
    ["Exportiert am", stamp(data.exportiert_am)],
  ]);
  info.getColumn(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- PDF (A4 quer) ---

const PAGE = { margin: 36, rowH: 15, headH: 17 };
const num = (v, digits = 2) => (v === null || v === undefined ? "" : Number(v).toLocaleString("de-CH", { minimumFractionDigits: digits, maximumFractionDigits: digits }));

// Tabelle mit Kopfzeile auf jeder Seite; rows: Arrays (Zellen) oder { group: "Überschrift" }
function pdfTable(doc, cols, rows) {
  const left = PAGE.margin;
  const width = cols.reduce((s, c) => s + c.width, 0);
  const bottom = () => doc.page.height - PAGE.margin - 14;
  const header = () => {
    doc.rect(left, doc.y, width, PAGE.headH).fill("#1f3a2e");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
    let x = left;
    const y = doc.y + 5;
    for (const c of cols) {
      doc.text(c.label, x + 4, y, { width: c.width - 8, height: 10, align: c.align || "left", ellipsis: true });
      x += c.width;
    }
    doc.y = y - 5 + PAGE.headH;
    doc.fillColor("#111111").font("Helvetica").fontSize(8);
  };
  header();
  let zebra = false;
  for (const row of rows) {
    if (doc.y + PAGE.rowH > bottom()) {
      doc.addPage();
      header();
    }
    const y = doc.y;
    if (row.group) {
      doc.rect(left, y, width, PAGE.rowH).fill("#e6ede9");
      doc.fillColor("#111111").font("Helvetica-Bold").text(row.group, left + 4, y + 4, { width: width - 8, height: 10, ellipsis: true });
      doc.font("Helvetica");
      zebra = false;
    } else {
      if (zebra) doc.rect(left, y, width, PAGE.rowH).fill("#f5f6f4");
      doc.fillColor("#111111");
      let x = left;
      row.forEach((cell, i) => {
        const c = cols[i];
        doc.text(cell === null || cell === undefined ? "" : String(cell), x + 4, y + 4, { width: c.width - 8, height: 10, align: c.align || "left", ellipsis: true });
        x += c.width;
      });
      zebra = !zebra;
    }
    doc.y = y + PAGE.rowH;
  }
  doc.y += 14;
}

function pdfHeading(doc, text) {
  if (doc.y + 60 > doc.page.height - PAGE.margin) doc.addPage();
  doc.font("Helvetica-Bold").fontSize(11).fillColor("#111111").text(text, PAGE.margin, doc.y);
  doc.y += 5;
}

const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function toPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: PAGE.margin, bufferPages: true, info: { Title: `Kursplanung – ${data.plan.name}` } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(16).text(data.pro ? `Einsatzplan ${data.pro}` : "Kursplanung", PAGE.margin, PAGE.margin);
    doc.font("Helvetica").fontSize(9).fillColor("#444444").text(
      `Plan «${data.plan.name}» · ${formatDate(data.zeitraum.von)} – ${formatDate(data.zeitraum.bis)} · ${data.summe.kurse} Kurse, ${data.summe.termine} Termine, ${num(data.summe.brutto_h, 1)} h brutto, ${num(data.summe.netto_h, 1)} h netto · exportiert am ${stamp(data.exportiert_am)}`
    );
    doc.y += 12;

    pdfHeading(doc, data.pro ? "Auslastung" : "Auslastung der Pros");
    pdfTable(doc, [
      { label: "Pro", width: 150 }, { label: "Kürzel", width: 60 },
      { label: "Kurse", width: 60, align: "right" }, { label: "Termine", width: 60, align: "right" },
      { label: "Brutto h (Zeitraum)", width: 100, align: "right" }, { label: "Netto h (Zeitraum)", width: 100, align: "right" },
      { label: "Sollstunden", width: 80, align: "right" }, { label: "Auslastung 2027", width: 90, align: "right" }, { label: "Ziel", width: 70, align: "right" },
    ], data.pros.map((p) => [p.name, p.kuerzel, p.kurse, p.termine, num(p.brutto_h), num(p.netto_h), p.sollstunden,
      p.auslastung_prozent === null ? "–" : `${num(p.auslastung_prozent, 1)} %`, `${p.ziel_prozent} %`]));

    pdfHeading(doc, "Kursanzahl je Kurstyp");
    pdfTable(doc, [
      { label: "ID", width: 60 }, { label: "Kurstyp", width: 190 }, { label: "Bereich", width: 55 },
      { label: "Kurse", width: 45, align: "right" }, { label: "Termine", width: 50, align: "right" },
      { label: "Brutto h", width: 55, align: "right" }, { label: "Max.", width: 40, align: "right" }, { label: "Pros (Kurse)", width: 275 },
    ], data.kurstypen.map((t) => [t.id, t.name, t.bereich, t.kurse, t.termine, num(t.brutto_h), t.max_stunden ?? "", proText(t.pros)]));

    doc.addPage();
    pdfHeading(doc, "Kurse");
    const rows = [];
    let month = "";
    for (const k of data.kurse) {
      if (k.datum.slice(0, 7) !== month) {
        month = k.datum.slice(0, 7);
        rows.push({ group: `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}` });
      }
      rows.push([formatDate(k.datum), k.wochentag.slice(0, 2), k.kw, `${k.beginn}–${k.unterricht_bis}`, k.pro,
        k.kurstyp_id ? `${k.kurstyp_id} · ${k.kurs}` : k.kurs, num(k.brutto_h), num(k.netto_h), k.notiz]);
    }
    if (!rows.length) rows.push({ group: "Keine Kurse im gewählten Zeitraum." });
    pdfTable(doc, [
      { label: "Datum", width: 62 }, { label: "Tag", width: 26 }, { label: "KW", width: 26, align: "right" }, { label: "Unterricht", width: 72 },
      { label: "Pro", width: 80 }, { label: "Kurs (Nr.) – Termin", width: 262 },
      { label: "Brutto h", width: 46, align: "right" }, { label: "Netto h", width: 46, align: "right" }, { label: "Notiz", width: 150 },
    ], rows);

    if (!data.pro && data.regeln.length) {
      pdfHeading(doc, "Regeln");
      pdfTable(doc, [{ label: "ID", width: 40 }, { label: "Regel", width: 670 }, { label: "Erfüllt", width: 60 }],
        data.regeln.map((r) => [r.id, r.regel, r.erfuellt ? "ja" : "nein"]));
    }

    // Fusszeile mit Seitenzahl auf jeder Seite
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(8).fillColor("#666666").text(
        `AI Academy Golf · ${data.plan.name} · Seite ${i + 1} von ${range.count}`,
        PAGE.margin, doc.page.height - PAGE.margin - 4, { width: doc.page.width - 2 * PAGE.margin, align: "right", lineBreak: false }
      );
    }
    doc.end();
  });
}

const FORMATS = {
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", render: toXlsx },
  pdf: { type: "application/pdf", render: toPdf },
  json: { type: "application/json; charset=utf-8", render: (data) => Buffer.from(JSON.stringify(data, null, 2)) },
};

// Dateiname «Kursplanung_<Plan>[_<Pro>]_<von>_<bis>.<format>»
function fileName(data, format) {
  const clean = (s) => String(s).normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return [`Kursplanung`, clean(data.plan.name), data.pro && clean(data.pro), data.zeitraum.von, data.zeitraum.bis].filter(Boolean).join("_") + `.${format}`;
}

module.exports = { FORMATS, collect, fileName };
