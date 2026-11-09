// Kurse: Brutto/Netto-Berechnung, Kurs-Dialog (einzeln oder Serie) und Kurse-Seite.
(function () {
  const D = window.Dates;
  const { el } = D;
  const $ = (sel) => document.querySelector(sel);

  const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

  let ctx = null; // { api, toast, reload, isAdmin, canEdit }
  let data = { pros: [], types: [], events: [] };
  let editingEvent = null;
  let editingType = null;

  // --- Berechnung ---

  function typeOf(ev) {
    return data.types.find((t) => t.id === ev.type_id);
  }

  // Wöchentlich: regelmässiger Kurs bis zum Ende des einplanbaren Zeitraums (wie server/events.js)
  function isWeekly(t) {
    return t?.wiederholung === "woechentlich";
  }

  function weeklyCap(t) {
    if (!t.max_stunden) return Infinity;
    const per = t.calc === "pauschal" ? t.brutto_fix_min
      : t.fixed_start_min !== null ? ((t.fixed_end_min - t.fixed_start_min) * t.brutto_min) / 30 : 0;
    return per > 0 ? Math.max(1, Math.floor((t.max_stunden * 60 + 0.01) / per)) : Infinity;
  }

  function isSeriesType(t) {
    return !!t && (isWeekly(t) || t.series_offsets.length > 1);
  }

  // Brutto bzw. Netto in Minuten:
  // faktor   → Typ-Angaben gelten pro 30 min geplanter Zeit
  // pauschal → feste Minuten pro Termin
  function minutesOf(ev, mode) {
    const t = typeOf(ev);
    if (!t) return 0;
    if (t.calc === "pauschal") return mode === "netto" ? t.netto_fix_min : t.brutto_fix_min;
    const per30 = mode === "netto" ? t.netto_min : t.brutto_min;
    return ((ev.end_min - ev.start_min) * per30) / 30;
  }

  // Belegte Zeit: Bei pauschalen Typen ist der Pro für die ganzen Brutto-Stunden belegt,
  // der Puffer hängt am Ende an (Platzreife: Kurs 10:00–12:30, 3 h brutto → bis 13:00).
  function bookedEnd(t, start, end) {
    if (t.calc !== "pauschal") return end;
    return Math.min(24 * 60, Math.max(end, start + t.brutto_fix_min));
  }

  // Ende des Unterrichts: Der Unterricht beginnt pünktlich, der ganze Puffer
  // liegt am Ende des Kurses.
  function lessonEnd(ev) {
    return Math.min(ev.end_min, Math.round(ev.start_min + minutesOf(ev, "netto")));
  }

  function timesText(t) {
    return t.series_times.map(([a, b]) => `${clock(a)}–${clock(b)}`).join(" · ");
  }

  // Schulferien (Kanton Zug): Kurse mit Schulferien-Regel überspringen gesperrte Wochen (wie server/events.js)
  const FERIEN = (window.FERIEN_ZUG || []).filter((f) => f.type === "ferien");
  function holidayOf(date) {
    const iso = D.isoKey(date);
    return FERIEN.find((f) => iso >= f.start && iso <= f.end)?.name || null;
  }

  // Gesperrt: «ausserhalb» = Tag liegt in den Ferien, «innerhalb» = Tag liegt ausserhalb der Ferien
  function holidayBlocked(t, date) {
    return (data.holidayTypes?.get(t.id) || []).some((m) => (m === "innerhalb" ? !holidayOf(date) : !!holidayOf(date)));
  }

  function seriesDates(t, first) {
    if (isWeekly(t)) {
      const end = D.parseDate(t.einplanbar_bis || `${first.getFullYear()}-12-31`);
      const cap = weeklyCap(t);
      const dates = [];
      for (let d = first; d <= end && dates.length < cap; d = D.addDays(d, 7)) if (!holidayBlocked(t, d)) dates.push(d);
      return dates;
    }
    if (!data.holidayTypes?.has(t.id)) return t.series_offsets.map((o) => D.addDays(first, o));
    const dates = [first];
    for (let i = 1; i < t.series_offsets.length; i++) {
      let date = D.addDays(dates[i - 1], t.series_offsets[i] - t.series_offsets[i - 1]);
      for (let guard = 0; holidayBlocked(t, date) && guard < 60; guard++) date = D.addDays(date, 7);
      dates.push(date);
    }
    return dates;
  }

  // Alle Termine derselben Serie, sortiert
  function seriesOf(ev) {
    if (!ev.series_id) return [ev];
    return data.events.filter((x) => x.series_id === ev.series_id).sort((a, b) => a.series_index - b.series_index);
  }

  // "Platzreife Teil 1 A · 2/4"
  function eventName(ev) {
    const name = typeOf(ev)?.name || "Kurs";
    const t = typeOf(ev);
    return ev.series_id && t ? `${name} · ${ev.series_index}/${isWeekly(t) ? seriesOf(ev).length : t.series_offsets.length}` : name;
  }

  // Geplante Stunden je Pro (Minuten brutto/netto) aus allen geladenen Kursen
  function plannedByPro() {
    const result = new Map();
    for (const ev of data.events) {
      const entry = result.get(ev.pro_id) || { brutto: 0, netto: 0 };
      entry.brutto += minutesOf(ev, "brutto");
      entry.netto += minutesOf(ev, "netto");
      result.set(ev.pro_id, entry);
    }
    return result;
  }

  // Geplant (brutto) in Prozent der Sollstunden; null wenn keine Sollstunden
  function percentOfSoll(pro, bruttoMinutes) {
    if (!pro.sollstunden) return null;
    return (bruttoMinutes / 60 / pro.sollstunden) * 100;
  }

  function formatPercent(value) {
    return `${value.toLocaleString("de-CH", { maximumFractionDigits: value < 10 ? 1 : 0 })} %`;
  }

  // 50 → "0:50 h", 90 → "1:30 h"
  function formatHM(min) {
    const total = Math.round(min);
    const h = Math.floor(total / 60);
    return `${h.toLocaleString("de-CH")}:${String(total % 60).padStart(2, "0")} h`;
  }

  // Kompakt für Rasterzellen: 90 → "1.5"
  function formatShortHours(min) {
    const h = Math.round((min / 60) * 10) / 10;
    return String(h);
  }

  function clock(min) {
    return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  }

  function parseClock(value) {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  }

  // Einsatzbereich eines Typs → Häkchen beim Pro (wie server/events.js)
  const AREAS = {
    kurse: { label: "Kurse", field: "kurse" },
    bambini: { label: "Bambini", field: "bambinitraining" },
    gce: { label: "GCE", field: "gce_training" },
  };

  // Geplante Sollstunden (brutto) eines Typs, über alle Pros
  function usageOf(t) {
    return data.events.filter((e) => e.type_id === t.id).reduce((sum, e) => sum + minutesOf(e, "brutto"), 0);
  }

  function windowText(t) {
    const day = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : "…");
    const range = t.einplanbar_von || t.einplanbar_bis ? `${day(t.einplanbar_von)}–${day(t.einplanbar_bis)}` : "ganzes Jahr";
    const h = (v) => v.toLocaleString("de-CH", { maximumFractionDigits: 1 });
    return t.max_stunden ? `${range} · ${h(usageOf(t) / 60)}/${h(t.max_stunden)} h` : range;
  }

  function allowedPros(t) {
    const area = AREAS[t?.einsatzbereich];
    return area ? data.pros.filter((p) => p[area.field]) : data.pros;
  }

  function proName(id) {
    return data.pros.find((p) => p.id === id)?.name || "–";
  }

  // "Sa, So, Sa, So" aus Wochentag des ersten Termins und Abständen
  function patternText(t) {
    if (isWeekly(t)) return `jede Woche ${D.WEEKDAYS[t.first_weekday]}`;
    if (t.first_weekday === null) return `${t.series_offsets.length} Termine`;
    return t.series_offsets.map((o) => D.WEEKDAYS[(t.first_weekday + o) % 7]).join(", ");
  }

  // --- Kurs-Dialog ---

  function fillSelect(select, items, label) {
    select.replaceChildren(...items.map((i) => new Option(label(i), String(i.id))));
  }

  function selectedType() {
    const f = $("#event-form").elements;
    return data.types.find((x) => String(x.id) === f.type_id.value);
  }

  function shortDate(date) {
    return `${D.WEEKDAYS[D.weekday(date)]} ${D.formatShort(date)}`;
  }

  // Termine der Serie: Datum je Termin und (unter «Erweitert») ein eigener Pro je Termin
  function renderSeriesRows() {
    const f = $("#event-form").elements;
    const t = selectedType();
    const box = $("#event-series");
    box.hidden = !isSeriesType(t) || !!editingEvent;
    if (box.hidden) return;

    const first = f.date.value ? D.parseDate(f.date.value) : null;
    const allDates = first ? seriesDates(t, first) : [];
    const previous = [...document.querySelectorAll("#event-series-rows select")].map((s) => s.value);
    const rows = $("#event-series-rows");
    rows.replaceChildren();
    const dates = [];
    const count = isWeekly(t) ? allDates.length : t.series_offsets.length;
    Array.from({ length: count }, (_, i) => i).forEach((i) => {
      const date = allDates[i] || null;
      const time = t.series_times ? ` ${clock(t.series_times[i][0])}` : "";
      dates.push(date ? `${shortDate(date)}${time}` : "–");
      const row = el("div", "series-row");
      row.append(el("span", "n", `Termin ${i + 1}`), el("span", "d", date ? `${shortDate(date)}${time}` : "–"));
      const select = el("select", "fsel");
      select.append(new Option(`wie oben (${proName(Number(f.pro_id.value))})`, ""));
      for (const p of allowedPros(t)) select.append(new Option(p.name, String(p.id)));
      select.value = previous[i] || "";
      row.append(select);
      rows.append(row);
    });
    $("#event-series-summary").textContent = `${count} Termine${isWeekly(t) ? " (wöchentlich bis Ende Zeitraum)" : ""}: ${dates.join(" · ")}`;
  }

  function updatePreview() {
    const f = $("#event-form").elements;
    const t = selectedType();
    const box = $("#event-preview");
    const start = f.start.value ? parseClock(f.start.value) : 0;
    const end = f.end.value ? parseClock(f.end.value) : 0;
    if (!t || end <= start) {
      box.textContent = "";
      return;
    }
    const ev = { type_id: t.id, start_min: start, end_min: end };
    const lesson = lessonEnd(ev);
    const per = isSeriesType(t) ? " pro Termin" : "";
    box.replaceChildren(
      el("span", "", `Brutto ${formatHM(minutesOf(ev, "brutto"))}${per}`),
      el("span", "", `Netto ${formatHM(minutesOf(ev, "netto"))}${per}`),
      el("span", "", `Unterricht ${clock(start)}–${clock(lesson)}`)
    );
    if (lesson < end) box.append(el("span", "", `Puffer ${clock(lesson)}–${clock(end)}`));
    if (isSeriesType(t) && !editingEvent) {
      const count = isWeekly(t) ? (f.date.value ? seriesDates(t, D.parseDate(f.date.value)).length : 0) : t.series_offsets.length;
      box.append(el("span", "", `${count} Termine · Total ${formatHM(minutesOf(ev, "brutto") * count)} brutto`));
    }
  }

  // Hinweis, wenn der Typ nur an einem bestimmten Wochentag beginnen darf
  function updateWeekdayHint() {
    const f = $("#event-form").elements;
    const t = selectedType();
    const hint = $("#event-weekday-hint");
    // Bestehende Serien-Termine liegen fest (Folgetermine dürfen an anderen Tagen sein)
    const wrong = !editingEvent?.series_id && t && t.first_weekday !== null && f.date.value
      && D.weekday(D.parseDate(f.date.value)) !== t.first_weekday;
    hint.hidden = !wrong;
    if (wrong) hint.textContent = `«${t.name}» beginnt immer an einem ${WEEKDAYS[t.first_weekday]}.`;
  }

  // Feste Zeit und Serie des gewählten Typs übernehmen
  function applyType({ adjustDate }) {
    const f = $("#event-form").elements;
    const t = selectedType();
    if (!t) return;
    // Nur Pros mit passendem Einsatzbereich zur Auswahl
    const pros = allowedPros(t);
    const current = Number(f.pro_id.value);
    fillSelect(f.pro_id, pros, (p) => p.name);
    if (pros.some((p) => p.id === current)) f.pro_id.value = String(current);
    const area = AREAS[t.einsatzbereich];
    const hint = $("#event-area-hint");
    hint.hidden = !area || (pros.some((p) => p.id === current) && pros.length > 0);
    hint.textContent = !pros.length
      ? `Kein Pro ist im Einsatzbereich ${area?.label} eingetragen.`
      : `«${proName(current)}» ist nicht im Einsatzbereich ${area?.label}; bitte einen passenden Pro wählen.`;
    f.date.min = t.einplanbar_von || "";
    f.date.max = t.einplanbar_bis || "";
    const fixed = t.fixed_start_min !== null;
    if (fixed) {
      f.start.value = clock(t.fixed_start_min);
      f.end.value = clock(bookedEnd(t, t.fixed_start_min, t.fixed_end_min));
    }
    const locked = fixed || !!editingEvent?.series_id;
    f.start.disabled = locked;
    f.end.disabled = locked;
    $("#event-fixed-hint").hidden = !fixed || !!editingEvent?.series_id;
    $("#event-fixed-hint").textContent = t.series_times
      ? `Die Zeiten sind je Termin fest vorgegeben: ${timesText(t)} (inkl. Puffer am Ende).`
      : "Die Zeit ist durch den Kurstyp fest vorgegeben (inkl. Puffer am Ende).";

    // Beim Wechsel auf einen Typ mit festem Wochentag zum nächsten passenden Tag springen
    if (adjustDate && t.first_weekday !== null && f.date.value) {
      const date = D.parseDate(f.date.value);
      const diff = (t.first_weekday - D.weekday(date) + 7) % 7;
      if (diff) f.date.value = D.isoKey(D.addDays(date, diff));
    }
    renderSeriesRows();
    updateWeekdayHint();
    updatePreview();
  }

  // Formular → Anfrage (anlegen bzw. ändern)
  function eventBody() {
    const f = $("#event-form").elements;
    const body = {
      type_id: Number(f.type_id.value),
      pro_id: Number(f.pro_id.value),
      date: f.date.value,
      start_min: f.start.value ? parseClock(f.start.value) : null,
      end_min: f.end.value ? parseClock(f.end.value) : null,
      notiz: f.notiz.value,
    };
    if (editingEvent?.series_id && f.serie.value) body.serie = f.serie.value;
    return body;
  }

  // Bestehenden Kurs ändern: Probelauf beim Server, zeigt betroffene Termine und Konflikte vor dem Speichern
  let checkTimer = null;
  let checkSeq = 0;
  function scheduleCheck() {
    clearTimeout(checkTimer);
    if (!editingEvent) return;
    checkTimer = setTimeout(runCheck, 250);
  }

  async function runCheck() {
    const box = $("#event-check");
    const save = $("#event-form button[type=submit]");
    const body = eventBody();
    const seq = ++checkSeq;
    let r;
    try {
      if (!body.date || body.start_min === null || body.end_min === null) throw new Error("");
      r = await ctx.api(`/events/${editingEvent.id}`, { method: "PUT", body: { ...body, dry_run: true } });
    } catch {
      if (seq === checkSeq) box.hidden = true;
      return;
    }
    if (seq !== checkSeq || !$("#dlg-event").open) return;
    const proName = (id) => data.pros.find((p) => p.id === id)?.name || "?";
    const changed = r.termine.filter((t) => t.datum !== t.datum_vorher || t.pro !== t.pro_vorher
      || t.zeit[0] !== t.zeit_vorher[0] || t.zeit[1] !== t.zeit_vorher[1]);
    box.replaceChildren();
    box.hidden = !changed.length && !r.konflikte.length;
    box.classList.toggle("bad", r.konflikte.length > 0);
    save.disabled = r.konflikte.length > 0;
    if (box.hidden) return;
    const series = !!editingEvent.series_id;
    if (changed.length) box.append(el("div", "mc-hd", series ? `Betroffene Termine (${changed.length})` : "Änderung"));
    for (const t of changed) {
      const parts = [];
      if (t.datum !== t.datum_vorher) parts.push(`${shortDate(D.parseDate(t.datum_vorher))} → ${shortDate(D.parseDate(t.datum))}`);
      else parts.push(shortDate(D.parseDate(t.datum)));
      if (t.zeit[0] !== t.zeit_vorher[0] || t.zeit[1] !== t.zeit_vorher[1]) parts.push(`${clock(t.zeit[0])}–${clock(t.zeit[1])}`);
      if (t.pro !== t.pro_vorher) parts.push(`${proName(t.pro_vorher)} → ${proName(t.pro)}`);
      const row = el("div", "mc-row");
      row.append(el("span", "n", series ? `Termin ${t.termin}` : "Kurs"), el("span", "", parts.join(" · ")));
      box.append(row);
    }
    const label = (k) => (k.termin && series ? `Termin ${k.termin}: ` : "");
    for (const k of r.konflikte) box.append(el("div", "mc-bad", `⚠ ${label(k)}${k.text}`));
    for (const k of r.hinweise) box.append(el("div", "mc-hint", `${label(k)}${k.text}`));
    if (!r.konflikte.length) box.append(el("div", "mc-ok", "✓ Keine Konflikte"));
  }

  // event: bestehender Kurs bearbeiten; prefill: { pro_id, date, start_min, end_min } für ein neues
  function openEvent(event, prefill = {}) {
    if (!event && !ctx.canEdit()) {
      ctx.toast("Dieser Plan ist für dich nur zum Ansehen freigegeben.");
      return;
    }
    if (!data.types.length) {
      ctx.toast("Es gibt noch keinen Kurstyp. Ein Admin muss zuerst einen anlegen.");
      return;
    }
    if (!data.pros.length) {
      ctx.toast("Es gibt noch keine Pros.");
      return;
    }
    editingEvent = event || null;
    const form = $("#event-form");
    form.reset();
    form.querySelector(".form-error").textContent = "";
    $("#event-series-rows").replaceChildren();
    $("#event-series-more").open = false;

    const series = !!event?.series_id;
    const t = event ? typeOf(event) : null;
    $("#event-title").textContent = series
      ? `${t?.name || "Serie"} · Termin ${event.series_index} von ${seriesOf(event).length}`
      : event ? "Kurs bearbeiten" : "Neuer Kurs";
    $("#event-delete").hidden = !event;
    $("#event-delete").textContent = series ? "Serie löschen" : "Löschen";
    $("#event-series-note").hidden = !series;
    // Serien-Termin: Pro-Wechsel nur für diesen, ab diesem oder für alle Termine der Serie
    $("#event-scope-wrap").hidden = !series;
    if (series) {
      const total = seriesOf(event).length;
      const last = Math.max(...seriesOf(event).map((x) => x.series_index));
      const options = [["", `nur diesen Termin (${event.series_index})`]];
      if (event.series_index < last) options.push(["folgende", `diesen und alle folgenden Termine (${event.series_index}–${last})`]);
      options.push(["alle", `alle ${total} Termine der Serie`]);
      $("#event-scope").replaceChildren(...options.map(([value, label]) => new Option(label, value)));
    }

    const f = form.elements;
    // Serien-Typen lassen sich nur neu anlegen, nicht aus einem einzelnen Kurs
    const types = event && !series ? data.types.filter((x) => !isSeriesType(x)) : data.types;
    fillSelect(f.type_id, types, (x) => (isWeekly(x) ? `${x.name} (wöchentlich)` : isSeriesType(x) ? `${x.name} (${x.series_offsets.length} Termine)` : x.name));
    fillSelect(f.pro_id, data.pros, (p) => p.name);
    const v = event || prefill;
    // Neuer Kurs für einen bestimmten Pro: ersten Typ wählen, den dieser Pro übernehmen darf
    const proPrefill = data.pros.find((p) => p.id === v.pro_id);
    const fitting = proPrefill && types.find((x) => allowedPros(x).includes(proPrefill));
    f.type_id.value = String(v.type_id || (fitting || types[0]).id);
    f.pro_id.value = String(v.pro_id || data.pros[0].id);
    f.date.value = v.date || D.isoKey(new Date(2027, 0, 4));
    f.start.value = clock(v.start_min ?? 9 * 60);
    f.end.value = clock(v.end_min ?? 10 * 60);
    f.notiz.value = v.notiz || "";
    f.type_id.disabled = series;
    applyType({ adjustDate: !event });
    $("#event-check").hidden = true;
    $("#event-form button[type=submit]").disabled = false;
    clearTimeout(checkTimer);
    checkSeq++;
    $("#dlg-event").showModal();
  }

  // Löscht ohne Rückfrage; die Meldung bietet «Rückgängig» an.
  // Termine einer Serie werden immer gemeinsam gelöscht und wiederhergestellt.
  async function deleteEvent(ev) {
    if (!ctx.canEdit()) return ctx.toast("Dieser Plan ist für dich nur zum Ansehen freigegeben.");
    const series = seriesOf(ev);
    const { undo_token: token } = await ctx.api(`/events/${ev.id}${ev.series_id ? "?serie=1" : ""}`, { method: "DELETE" });
    const t = typeOf(ev);
    const label = ev.series_id
      ? `${t?.name || "Serie"} (${series.length} Termine) gelöscht`
      : `${t?.name || "Kurs"} ${clock(ev.start_min)}–${clock(ev.end_min)} gelöscht`;
    // Rückgängig stellt die gelöschten Termine unverändert wieder her (inkl. Notiz je Termin)
    ctx.toast(label, token && {
      label: "Rückgängig",
      run: async () => {
        try {
          await ctx.api(`/undo/${token}`, { method: "POST" });
          ctx.toast(ev.series_id ? "Serie wiederhergestellt" : "Kurs wiederhergestellt");
          ctx.reload();
        } catch (err) {
          ctx.toast(err.message);
        }
      },
    });
    ctx.reload();
  }

  // Rechtsklick-Menü für einen bestehenden Kurs
  function eventMenu(e, ev) {
    const series = ev.series_id ? seriesOf(ev) : null;
    ContextMenu.open(e, [
      {
        label: series ? `Termin ${ev.series_index} bearbeiten` : "Bearbeiten",
        hint: `${eventName(ev)} · ${clock(ev.start_min)}–${clock(ev.end_min)}`,
        action: () => openEvent(ev),
      },
      {
        label: series ? `Serie löschen (${series.length} Termine)` : "Löschen",
        danger: true,
        action: () => deleteEvent(ev).catch((err) => ctx.toast(err.message)),
      },
    ]);
  }

  // --- Kurstyp-Dialog (Admin) ---

  function updateTypeForm() {
    const f = $("#type-form").elements;
    const pauschal = f.calc.value === "pauschal";
    $("#type-faktor").hidden = pauschal;
    $("#type-pauschal").hidden = !pauschal;
    const offsets = parseOffsets(f.series_offsets.value);
    const weekday = f.first_weekday.value === "" ? null : Number(f.first_weekday.value);
    const weekly = f.wiederholung.value === "woechentlich";
    $("#type-offsets-wrap").hidden = weekly;
    $("#type-weekday-label").textContent = weekly ? "Wochentag" : "Erster Termin nur am";
    $("#type-times-row").hidden = weekly || (!(offsets && offsets.length > 1) && !f.series_times.value);
    if (weekly) {
      const day = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : null);
      const until = day(f.einplanbar_bis.value) || "Jahresende";
      $("#type-pattern").textContent = weekday === null
        ? "Bitte den Wochentag wählen."
        : `→ jeden ${D.WEEKDAYS_LONG?.[weekday] || WEEKDAYS[weekday]} ab dem gewählten Start bis ${until}${f.max_stunden.value ? `, höchstens so viele Termine, wie die Max. Sollstunden erlauben` : ""}. Wochen, die eine Schulferien-Regel sperrt, fallen weg. Beim Auslasten startet der Kurs in der ersten möglichen Woche des Zeitraums (eine Gruppe je Kurstyp).`;
      return;
    }
    $("#type-pattern").textContent = offsets
      ? offsets.length > 1
        ? `→ ${offsets.length} Termine${weekday === null ? "" : `: ${offsets.map((o) => D.WEEKDAYS[(weekday + o) % 7]).join(", ")}`}`
        : "→ einzelner Termin"
      : "Bitte Zahlen mit Komma trennen, z. B. 0, 1, 7, 8";
  }

  function parseOffsets(text) {
    const parts = text.split(/[,;\s]+/).filter(Boolean);
    if (!parts.length) return [0];
    const nums = parts.map(Number);
    return nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : null;
  }

  const hours = (min) => (min === null || min === undefined ? "" : String(min / 60));

  function openType(type) {
    editingType = type || null;
    const form = $("#type-form");
    form.reset();
    form.querySelector(".form-error").textContent = "";
    $("#type-title").textContent = type ? `${type.name} bearbeiten` : "Neuer Kurstyp";
    $("#type-delete").hidden = !type;
    const f = form.elements;
    f.name.value = type?.name || "";
    f.code.value = type?.code || "";
    f.einsatzbereich.value = type ? type.einsatzbereich || "" : "kurse";
    f.einplanbar_von.value = type?.einplanbar_von || "";
    f.einplanbar_bis.value = type?.einplanbar_bis || "";
    f.max_stunden.value = type?.max_stunden ?? "";
    f.color.value = type?.color || "#6a8fd8";
    f.calc.value = type?.calc || "faktor";
    f.brutto_min.value = type?.brutto_min ?? 30;
    f.netto_min.value = type?.netto_min ?? 25;
    f.brutto_fix.value = hours(type?.brutto_fix_min);
    f.netto_fix.value = hours(type?.netto_fix_min);
    f.fixed_start.value = type?.fixed_start_min != null ? clock(type.fixed_start_min) : "";
    f.fixed_end.value = type?.fixed_end_min != null ? clock(type.fixed_end_min) : "";
    f.first_weekday.value = type?.first_weekday != null ? String(type.first_weekday) : "";
    f.wiederholung.value = type?.wiederholung || "";
    f.series_offsets.value = (type?.series_offsets || [0]).join(", ");
    f.series_times.value = type?.series_times ? type.series_times.map(([a, b]) => `${clock(a)}-${clock(b)}`).join(", ") : "";
    renderParallel(type);
    updateTypeForm();
    $("#dlg-type").showModal();
  }

  // «Darf nicht parallel stattfinden zu»: Häkchen-Liste aller anderen Kurstypen
  function renderParallel(type) {
    const chosen = new Set(type?.nicht_parallel || []);
    const list = $("#type-parallel-list");
    list.replaceChildren();
    // Der Kurstyp selbst: keine zwei Kurse dieses Typs gleichzeitig (neuer Typ: «selbst», ID gibt es noch nicht)
    const self = el("label");
    const selfBox = el("input");
    Object.assign(selfBox, { type: "checkbox", value: type ? String(type.id) : "selbst", checked: !!type && chosen.has(type.id) });
    selfBox.dataset.self = "1";
    selfBox.addEventListener("change", updateParallelSummary);
    self.append(selfBox, el("b", "", "Dieser Kurstyp selbst"), el("span", "muted", " – keine zwei gleichzeitig"));
    list.append(self);
    for (const t of sortedTypes().filter((x) => x.id !== type?.id)) {
      const row = el("label");
      const box = el("input");
      Object.assign(box, { type: "checkbox", value: String(t.id), checked: chosen.has(t.id) });
      box.addEventListener("change", updateParallelSummary);
      const dot = el("span", "gdot");
      dot.style.background = t.color;
      row.append(box, dot, document.createTextNode(t.code ? `${t.code} · ${t.name}` : t.name));
      list.append(row);
    }
    $("#type-parallel").open = false;
    updateParallelSummary();
  }

  function parallelIds() {
    return [...document.querySelectorAll("#type-parallel-list input:checked")].map((b) => (b.value === "selbst" ? "selbst" : Number(b.value)));
  }

  function updateParallelSummary() {
    const names = [...document.querySelectorAll("#type-parallel-list input:checked")]
      .map((b) => (b.dataset.self ? "sich selbst" : data.types.find((t) => t.id === Number(b.value))))
      .map((t) => (typeof t === "string" ? t : t.code || t.name));
    $("#type-parallel-sum").textContent = names.length ? names.join(", ") : "keinem Kurstyp";
  }

  function readTypeForm() {
    const f = $("#type-form").elements;
    const offsets = parseOffsets(f.series_offsets.value);
    if (!offsets) throw new Error("Abstände der Termine: bitte Zahlen mit Komma trennen, z. B. 0, 1, 7, 8.");
    const toMin = (v) => (v === "" ? null : Math.round(Number(v) * 60));
    return {
      name: f.name.value,
      code: f.code.value,
      einsatzbereich: f.einsatzbereich.value || null,
      einplanbar_von: f.einplanbar_von.value || null,
      einplanbar_bis: f.einplanbar_bis.value || null,
      max_stunden: f.max_stunden.value === "" ? null : Number(f.max_stunden.value),
      color: f.color.value,
      calc: f.calc.value,
      brutto_min: Number(f.brutto_min.value),
      netto_min: Number(f.netto_min.value),
      brutto_fix_min: toMin(f.brutto_fix.value),
      netto_fix_min: toMin(f.netto_fix.value),
      fixed_start_min: f.fixed_start.value ? parseClock(f.fixed_start.value) : null,
      fixed_end_min: f.fixed_end.value ? parseClock(f.fixed_end.value) : null,
      first_weekday: f.first_weekday.value === "" ? null : Number(f.first_weekday.value),
      series_offsets: offsets,
      series_times: f.series_times.value.trim() ? f.series_times.value.split(/\s*[,;]\s*/).filter(Boolean) : null,
      nicht_parallel: parallelIds(),
      wiederholung: f.wiederholung.value || null,
    };
  }

  // --- Kurse-Seite ---

  function hoursText(t) {
    if (t.calc === "pauschal") {
      return `pro Termin ${formatHM(t.brutto_fix_min)} brutto · ${formatHM(t.netto_fix_min)} netto`;
    }
    const ev = { type_id: t.id, start_min: 0, end_min: 60 };
    return `${t.brutto_min}/${t.netto_min} min pro 30 min · 1 h = ${formatHM(minutesOf(ev, "brutto"))} brutto · ${formatHM(minutesOf(ev, "netto"))} netto`;
  }

  // Sortierung der Typenliste (Klick auf Spaltenkopf, wird im Browser gemerkt)
  let typeSort = { key: "code", dir: 1 };
  try {
    typeSort = JSON.parse(localStorage.getItem("academy.typeSort")) || typeSort;
  } catch {}

  const naturally = new Intl.Collator("de", { numeric: true, sensitivity: "base" });
  const SORT_VALUES = {
    code: (t) => t.code,
    name: (t) => t.name,
    time: (t) => t.fixed_start_min,
    terms: (t) => (isWeekly(t) ? 99 : t.series_offsets.length),
    area: (t) => AREAS[t.einsatzbereich]?.label ?? "alle",
  };

  let areaFilter = "";

  function sortedTypes() {
    const value = SORT_VALUES[typeSort.key] || SORT_VALUES.code;
    return [...data.types].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      // Leere Werte (z. B. ohne ID oder ohne feste Zeit) immer ans Ende
      if (va == null || vb == null) return va == null && vb == null ? naturally.compare(a.name, b.name) : va == null ? 1 : -1;
      const diff = typeof va === "number" ? va - vb : naturally.compare(va, vb);
      return diff * typeSort.dir || naturally.compare(a.name, b.name);
    });
  }

  function setTypeSort(key) {
    typeSort = { key, dir: typeSort.key === key ? -typeSort.dir : 1 };
    try {
      localStorage.setItem("academy.typeSort", JSON.stringify(typeSort));
    } catch {}
    renderTypes();
  }

  function renderTypes() {
    const tbody = $("#type-list");
    tbody.replaceChildren();
    document.querySelectorAll("#type-head th[data-sort]").forEach((th) => {
      th.classList.toggle("sorted", th.dataset.sort === typeSort.key);
      th.dataset.dir = th.dataset.sort === typeSort.key ? (typeSort.dir > 0 ? "asc" : "desc") : "";
    });
    const shown = sortedTypes().filter((t) => !areaFilter || t.einsatzbereich === areaFilter || !t.einsatzbereich);
    for (const t of shown) {
      const tr = el("tr");
      const name = el("td");
      const dot = el("span", "gdot");
      dot.style.background = t.color;
      name.append(dot, document.createTextNode(t.name));
      const avoid = (t.nicht_parallel || []).map((id) => data.types.find((x) => x.id === id)).filter(Boolean);
      if (avoid.length) name.append(el("span", "type-sub", `nicht parallel zu ${avoid.map((x) => (x.id === t.id ? "sich selbst" : x.code || x.name)).join(", ")}`));
      const booked = t.fixed_start_min !== null ? bookedEnd(t, t.fixed_start_min, t.fixed_end_min) : null;
      const time = t.series_times
        ? `je Termin ${timesText(t)}`
        : t.fixed_start_min === null
        ? "frei wählbar"
        : `${clock(t.fixed_start_min)}–${clock(t.fixed_end_min)}${booked > t.fixed_end_min ? `, Puffer bis ${clock(booked)}` : ""}`;
      const terms = isWeekly(t) ? `wöchentlich (${D.WEEKDAYS[t.first_weekday]})` : isSeriesType(t) ? `${t.series_offsets.length} (${patternText(t)})` : t.first_weekday !== null ? `1 (${D.WEEKDAYS[t.first_weekday]})` : "1";
      tr.append(el("td", "tab muted", t.code || "–"), name, el("td", "", AREAS[t.einsatzbereich]?.label ?? "alle"), el("td", "tab muted", windowText(t)), el("td", "muted", hoursText(t)), el("td", "tab", time), el("td", "", terms));
      const actions = el("td");
      if (ctx.isAdmin()) {
        const btn = el("button", "btn sm", "Bearbeiten");
        btn.type = "button";
        btn.addEventListener("click", () => openType(t));
        actions.append(btn);
      }
      tr.append(actions);
      tbody.append(tr);
    }
    $("#type-empty").hidden = data.types.length > 0;
  }

  // --- Kursanzahl je Kurstyp (Reiter «Geplante Kurse») ---

  let listFilter = null; // Typ-ID, nach der die Liste «Alle Kurse» gefiltert ist

  // Überschneidungen je Termin: gleicher Kurstyp bzw. verbotener Partner («nicht parallel zu», inkl. selbst)
  function overlapsByEvent(events) {
    const byDate = new Map();
    for (const ev of events) (byDate.get(ev.date) || byDate.set(ev.date, []).get(ev.date)).push(ev);
    const same = new Set();
    const forbidden = new Set();
    for (const list of byDate.values()) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i];
          const b = list[j];
          if (!(a.start_min < b.end_min && b.start_min < a.end_min)) continue;
          if (a.type_id === b.type_id) {
            same.add(a.id);
            same.add(b.id);
          }
          if (typeOf(a)?.nicht_parallel?.includes(b.type_id) || typeOf(b)?.nicht_parallel?.includes(a.type_id)) {
            forbidden.add(a.id);
            forbidden.add(b.id);
          }
        }
      }
    }
    return { same, forbidden };
  }

  function renderCounts() {
    const tbody = $("#count-list");
    tbody.replaceChildren();
    const events = data.events.filter((e) => e.date >= "2027-01-01" && e.date <= "2027-12-31");
    const { same, forbidden } = overlapsByEvent(events);
    let totalCourses = 0;
    for (const t of sortedTypes()) {
      const list = events.filter((e) => e.type_id === t.id);
      if (!list.length) continue;
      const courses = new Map(); // Serie bzw. Einzeltermin → Pro des ersten Termins
      for (const e of [...list].sort((a, b) => (a.series_index || 0) - (b.series_index || 0))) {
        const key = e.series_id || `e${e.id}`;
        if (!courses.has(key)) courses.set(key, e.pro_id);
      }
      totalCourses += courses.size;
      const perPro = new Map();
      for (const pid of courses.values()) perPro.set(pid, (perPro.get(pid) || 0) + 1);
      const brutto = list.reduce((s, e) => s + minutesOf(e, "brutto"), 0);
      const sameCount = list.filter((e) => same.has(e.id)).length;
      const badCount = list.filter((e) => forbidden.has(e.id)).length;

      const tr = el("tr", `clickable${listFilter === t.id ? " on" : ""}`);
      const name = el("td");
      const dot = el("span", "gdot");
      dot.style.background = t.color;
      name.append(dot, document.createTextNode(t.code ? `${t.code} · ${t.name}` : t.name));
      const parallel = el("td");
      if (badCount) parallel.append(el("span", "count-bad", `${badCount} Termine verboten gleichzeitig`));
      if (sameCount && !t.nicht_parallel?.includes(t.id)) {
        if (badCount) parallel.append(document.createTextNode(" · "));
        parallel.append(el("span", "muted", `${sameCount} Termine mit gleichem Kurstyp`));
      }
      if (!badCount && !(sameCount && !t.nicht_parallel?.includes(t.id))) parallel.append(el("span", "muted", "–"));
      const pros = [...perPro].sort((a, b) => b[1] - a[1]).map(([pid, n]) => `${proName(pid)} ${n}`).join(", ");
      tr.append(
        name,
        el("td", "num tab", String(courses.size)),
        el("td", "num tab", String(list.length)),
        el("td", "num tab", `${formatHM(brutto)}${t.max_stunden ? ` / ${t.max_stunden} h` : ""}`),
        el("td", "muted", pros),
        parallel
      );
      tr.addEventListener("click", () => {
        listFilter = listFilter === t.id ? null : t.id;
        renderCounts();
        renderEventList();
      });
      tbody.append(tr);
    }
    $("#count-table").hidden = !tbody.children.length;
    $("#count-sum").textContent = tbody.children.length ? `${totalCourses} Kurse in ${tbody.children.length} Kurstypen` : "Noch keine Kurse geplant.";
  }

  function renderEventList() {
    const tbody = $("#event-list");
    tbody.replaceChildren();
    if (listFilter && !data.types.some((t) => t.id === listFilter)) listFilter = null;
    const filterType = listFilter && data.types.find((t) => t.id === listFilter);
    $("#event-filter-clear").hidden = !filterType;
    if (filterType) $("#event-filter-clear").textContent = `Nur «${filterType.name}» ✕`;
    const sorted = data.events.filter((e) => !listFilter || e.type_id === listFilter)
      .sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
    let brutto = 0;
    let netto = 0;
    for (const ev of sorted) {
      const t = typeOf(ev);
      const b = minutesOf(ev, "brutto");
      const n = minutesOf(ev, "netto");
      brutto += b;
      netto += n;
      const tr = el("tr", "clickable");
      const typeCell = el("td");
      const dot = el("span", "gdot");
      dot.style.background = t?.color || "var(--line-2)";
      typeCell.append(dot, document.createTextNode(eventName(ev)));
      tr.append(
        el("td", "tab", D.formatDate(ev.date)),
        el("td", "tab", `${clock(ev.start_min)}–${clock(ev.end_min)}`),
        el("td", "", proName(ev.pro_id)),
        typeCell,
        el("td", "num", formatHM(b)),
        el("td", "num", formatHM(n)),
        el("td", "muted", ev.notiz)
      );
      tr.addEventListener("click", () => openEvent(ev));
      tr.addEventListener("contextmenu", (e) => eventMenu(e, ev));
      tbody.append(tr);
    }
    $("#event-empty").hidden = sorted.length > 0;
    $("#event-table").hidden = sorted.length === 0;
    $("#event-sum").textContent = sorted.length
      ? `${sorted.length} ${sorted.length === 1 ? "Kurs" : "Kurse"} · ${formatHM(brutto)} brutto · ${formatHM(netto)} netto`
      : "";
  }

  function render() {
    $("#btn-new-type").hidden = !ctx.isAdmin();
    renderTypes();
    renderCounts();
    renderEventList();
  }

  function setData(next) {
    data = next;
    if (!$("#page-events").hidden || !$("#page-planned").hidden) render();
  }

  // --- Initialisierung ---

  function init(context) {
    ctx = context;
    document.querySelectorAll("#type-head th[data-sort]").forEach((th) => {
      th.title = "Sortieren";
      th.addEventListener("click", () => setTypeSort(th.dataset.sort));
    });
    document.querySelectorAll("#type-area-filter button").forEach((btn) =>
      btn.addEventListener("click", () => {
        areaFilter = btn.dataset.area;
        document.querySelectorAll("#type-area-filter button").forEach((b) => b.classList.toggle("on", b === btn));
        renderTypes();
      })
    );

    const ef = $("#event-form");
    ef.elements.type_id.addEventListener("change", () => applyType({ adjustDate: true }));
    ef.elements.date.addEventListener("input", () => {
      renderSeriesRows();
      updateWeekdayHint();
    });
    ef.elements.pro_id.addEventListener("change", () => {
      $("#event-area-hint").hidden = true;
      renderSeriesRows();
    });
    ["start", "end"].forEach((n) => ef.elements[n].addEventListener("input", updatePreview));

    ["type_id", "pro_id", "date", "start", "end", "serie"].forEach((n) => {
      ef.elements[n].addEventListener("input", scheduleCheck);
      ef.elements[n].addEventListener("change", scheduleCheck);
    });

    ef.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = ef.elements;
      const body = eventBody();
      const perTermin = [...document.querySelectorAll("#event-series-rows select")];
      if (!editingEvent && perTermin.length) body.pros = perTermin.map((s) => (s.value ? Number(s.value) : null));
      try {
        const result = await ctx.api(editingEvent ? `/events/${editingEvent.id}` : "/events", {
          method: editingEvent ? "PUT" : "POST",
          body,
        });
        $("#dlg-event").close();
        const count = result.events?.length || 1;
        ctx.toast(editingEvent
          ? count > 1 ? `${count} Termine der Serie geändert` : "Kurs gespeichert"
          : count > 1 ? `Serie mit ${count} Terminen erstellt` : "Kurs erstellt");
        ctx.reload();
      } catch (err) {
        ef.querySelector(".form-error").textContent = err.message;
      }
    });
    $("#event-delete").addEventListener("click", async () => {
      if (!editingEvent) return;
      try {
        await deleteEvent(editingEvent);
        $("#dlg-event").close();
      } catch (err) {
        ef.querySelector(".form-error").textContent = err.message;
      }
    });

    const tf = $("#type-form");
    ["calc", "series_offsets", "series_times", "first_weekday", "wiederholung", "einplanbar_bis", "max_stunden"].forEach((n) => tf.elements[n].addEventListener("input", updateTypeForm));
    tf.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const saved = await ctx.api(editingType ? `/event-types/${editingType.id}` : "/event-types", {
          method: editingType ? "PUT" : "POST",
          body: readTypeForm(),
        });
        $("#dlg-type").close();
        const { type, warnung } = saved;
        ctx.toast(warnung || (editingType ? `«${type.name}» gespeichert` : `Kurstyp «${type.name}» angelegt`));
        ctx.reload();
      } catch (err) {
        tf.querySelector(".form-error").textContent = err.message;
      }
    });
    $("#type-delete").addEventListener("click", async () => {
      if (!editingType) return;
      try {
        await ctx.api(`/event-types/${editingType.id}`, { method: "DELETE" });
        $("#dlg-type").close();
        ctx.toast(`Kurstyp «${editingType.name}» gelöscht`);
        ctx.reload();
      } catch (err) {
        tf.querySelector(".form-error").textContent = err.message;
      }
    });

    document.querySelectorAll("[data-new-event]").forEach((btn) => btn.addEventListener("click", () => openEvent(null)));
    $("#event-filter-clear").addEventListener("click", () => {
      listFilter = null;
      renderCounts();
      renderEventList();
    });
    $("#btn-new-type").addEventListener("click", () => openType(null));
  }

  window.Events = {
    init, setData, render, openEvent, eventMenu, eventName, minutesOf, lessonEnd,
    plannedByPro, percentOfSoll, formatPercent, formatHM, formatShortHours, clock, typeOf,
  };
})();
