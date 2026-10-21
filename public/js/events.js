// Events: Brutto/Netto-Berechnung, Event-Dialog (einzeln oder Serie) und Events-Seite.
(function () {
  const D = window.Dates;
  const { el } = D;
  const $ = (sel) => document.querySelector(sel);

  const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

  let ctx = null; // { api, toast, reload, isAdmin }
  let data = { pros: [], types: [], events: [] };
  let editingEvent = null;
  let editingType = null;

  // --- Berechnung ---

  function typeOf(ev) {
    return data.types.find((t) => t.id === ev.type_id);
  }

  function isSeriesType(t) {
    return !!t && t.series_offsets.length > 1;
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
  // liegt am Ende des Events.
  function lessonEnd(ev) {
    return Math.min(ev.end_min, Math.round(ev.start_min + minutesOf(ev, "netto")));
  }

  // Alle Termine derselben Serie, sortiert
  function seriesOf(ev) {
    if (!ev.series_id) return [ev];
    return data.events.filter((x) => x.series_id === ev.series_id).sort((a, b) => a.series_index - b.series_index);
  }

  // "Platzreife Teil 1 A · 2/4"
  function eventName(ev) {
    const name = typeOf(ev)?.name || "Event";
    const t = typeOf(ev);
    return ev.series_id && t ? `${name} · ${ev.series_index}/${t.series_offsets.length}` : name;
  }

  // Geplante Stunden je Pro (Minuten brutto/netto) aus allen geladenen Events
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

  function proName(id) {
    return data.pros.find((p) => p.id === id)?.name || "–";
  }

  // "Sa, So, Sa, So" aus Wochentag des ersten Termins und Abständen
  function patternText(t) {
    if (t.first_weekday === null) return `${t.series_offsets.length} Termine`;
    return t.series_offsets.map((o) => D.WEEKDAYS[(t.first_weekday + o) % 7]).join(", ");
  }

  // --- Event-Dialog ---

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
    const previous = [...document.querySelectorAll("#event-series-rows select")].map((s) => s.value);
    const rows = $("#event-series-rows");
    rows.replaceChildren();
    const dates = [];
    t.series_offsets.forEach((offset, i) => {
      const date = first ? D.addDays(first, offset) : null;
      dates.push(date ? shortDate(date) : "–");
      const row = el("div", "series-row");
      row.append(el("span", "n", `Termin ${i + 1}`), el("span", "d", date ? shortDate(date) : "–"));
      const select = el("select", "fsel");
      select.append(new Option(`wie oben (${proName(Number(f.pro_id.value))})`, ""));
      for (const p of data.pros) select.append(new Option(p.name, String(p.id)));
      select.value = previous[i] || "";
      row.append(select);
      rows.append(row);
    });
    $("#event-series-summary").textContent = `${t.series_offsets.length} Termine: ${dates.join(" · ")}`;
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
      box.append(el("span", "", `Total ${formatHM(minutesOf(ev, "brutto") * t.series_offsets.length)} brutto`));
    }
  }

  // Hinweis, wenn der Typ nur an einem bestimmten Wochentag beginnen darf
  function updateWeekdayHint() {
    const f = $("#event-form").elements;
    const t = selectedType();
    const hint = $("#event-weekday-hint");
    const wrong = t && t.first_weekday !== null && f.date.value && D.weekday(D.parseDate(f.date.value)) !== t.first_weekday;
    hint.hidden = !wrong;
    if (wrong) hint.textContent = `«${t.name}» beginnt immer an einem ${WEEKDAYS[t.first_weekday]}.`;
  }

  // Feste Zeit und Serie des gewählten Typs übernehmen
  function applyType({ adjustDate }) {
    const f = $("#event-form").elements;
    const t = selectedType();
    if (!t) return;
    const fixed = t.fixed_start_min !== null;
    if (fixed) {
      f.start.value = clock(t.fixed_start_min);
      f.end.value = clock(bookedEnd(t, t.fixed_start_min, t.fixed_end_min));
    }
    const locked = fixed || !!editingEvent?.series_id;
    f.start.disabled = locked;
    f.end.disabled = locked;
    $("#event-fixed-hint").hidden = !fixed || !!editingEvent?.series_id;

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

  // event: bestehendes Event bearbeiten; prefill: { pro_id, date, start_min, end_min } für ein neues
  function openEvent(event, prefill = {}) {
    if (!data.types.length) {
      ctx.toast("Es gibt noch keinen Event-Typ. Ein Admin muss zuerst einen anlegen.");
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
      ? `${t?.name || "Serie"} · Termin ${event.series_index} von ${t?.series_offsets.length ?? "?"}`
      : event ? "Event bearbeiten" : "Neues Event";
    $("#event-delete").hidden = !event;
    $("#event-delete").textContent = series ? "Serie löschen" : "Löschen";
    $("#event-series-note").hidden = !series;

    const f = form.elements;
    // Serien-Typen lassen sich nur neu anlegen, nicht aus einem einzelnen Event
    const types = event && !series ? data.types.filter((x) => !isSeriesType(x)) : data.types;
    fillSelect(f.type_id, types, (x) => (isSeriesType(x) ? `${x.name} (${x.series_offsets.length} Termine)` : x.name));
    fillSelect(f.pro_id, data.pros, (p) => p.name);
    const v = event || prefill;
    f.type_id.value = String(v.type_id || types[0].id);
    f.pro_id.value = String(v.pro_id || data.pros[0].id);
    f.date.value = v.date || D.isoKey(new Date(2027, 0, 4));
    f.start.value = clock(v.start_min ?? 9 * 60);
    f.end.value = clock(v.end_min ?? 10 * 60);
    f.notiz.value = v.notiz || "";
    f.type_id.disabled = series;
    f.date.disabled = series;
    applyType({ adjustDate: !event });
    $("#dlg-event").showModal();
  }

  // Löscht ohne Rückfrage; die Meldung bietet «Rückgängig» an.
  // Termine einer Serie werden immer gemeinsam gelöscht und wiederhergestellt.
  async function deleteEvent(ev) {
    const series = seriesOf(ev);
    await ctx.api(`/events/${ev.id}${ev.series_id ? "?serie=1" : ""}`, { method: "DELETE" });
    const t = typeOf(ev);
    const label = ev.series_id
      ? `${t?.name || "Serie"} (${series.length} Termine) gelöscht`
      : `${t?.name || "Event"} ${clock(ev.start_min)}–${clock(ev.end_min)} gelöscht`;
    ctx.toast(label, {
      label: "Rückgängig",
      run: async () => {
        try {
          const first = series[0];
          const body = ev.series_id
            ? { type_id: first.type_id, date: first.date, pro_id: first.pro_id, pros: series.map((x) => x.pro_id), notiz: first.notiz }
            : { type_id: ev.type_id, pro_id: ev.pro_id, date: ev.date, start_min: ev.start_min, end_min: ev.end_min, notiz: ev.notiz };
          await ctx.api("/events", { method: "POST", body });
          ctx.toast(ev.series_id ? "Serie wiederhergestellt" : "Event wiederhergestellt");
          ctx.reload();
        } catch (err) {
          ctx.toast(err.message);
        }
      },
    });
    ctx.reload();
  }

  // Rechtsklick-Menü für ein bestehendes Event
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

  // --- Event-Typ-Dialog (Admin) ---

  function updateTypeForm() {
    const f = $("#type-form").elements;
    const pauschal = f.calc.value === "pauschal";
    $("#type-faktor").hidden = pauschal;
    $("#type-pauschal").hidden = !pauschal;
    const offsets = parseOffsets(f.series_offsets.value);
    const weekday = f.first_weekday.value === "" ? null : Number(f.first_weekday.value);
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
    $("#type-title").textContent = type ? `${type.name} bearbeiten` : "Neuer Event-Typ";
    $("#type-delete").hidden = !type;
    const f = form.elements;
    f.name.value = type?.name || "";
    f.color.value = type?.color || "#6a8fd8";
    f.calc.value = type?.calc || "faktor";
    f.brutto_min.value = type?.brutto_min ?? 30;
    f.netto_min.value = type?.netto_min ?? 25;
    f.brutto_fix.value = hours(type?.brutto_fix_min);
    f.netto_fix.value = hours(type?.netto_fix_min);
    f.fixed_start.value = type?.fixed_start_min != null ? clock(type.fixed_start_min) : "";
    f.fixed_end.value = type?.fixed_end_min != null ? clock(type.fixed_end_min) : "";
    f.first_weekday.value = type?.first_weekday != null ? String(type.first_weekday) : "";
    f.series_offsets.value = (type?.series_offsets || [0]).join(", ");
    updateTypeForm();
    $("#dlg-type").showModal();
  }

  function readTypeForm() {
    const f = $("#type-form").elements;
    const offsets = parseOffsets(f.series_offsets.value);
    if (!offsets) throw new Error("Abstände der Termine: bitte Zahlen mit Komma trennen, z. B. 0, 1, 7, 8.");
    const toMin = (v) => (v === "" ? null : Math.round(Number(v) * 60));
    return {
      name: f.name.value,
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
    };
  }

  // --- Events-Seite ---

  function hoursText(t) {
    if (t.calc === "pauschal") {
      return `pro Termin ${formatHM(t.brutto_fix_min)} brutto · ${formatHM(t.netto_fix_min)} netto`;
    }
    const ev = { type_id: t.id, start_min: 0, end_min: 60 };
    return `${t.brutto_min}/${t.netto_min} min pro 30 min · 1 h = ${formatHM(minutesOf(ev, "brutto"))} brutto · ${formatHM(minutesOf(ev, "netto"))} netto`;
  }

  function renderTypes() {
    const tbody = $("#type-list");
    tbody.replaceChildren();
    for (const t of data.types) {
      const tr = el("tr");
      const name = el("td");
      const dot = el("span", "gdot");
      dot.style.background = t.color;
      name.append(dot, document.createTextNode(t.name));
      const booked = t.fixed_start_min !== null ? bookedEnd(t, t.fixed_start_min, t.fixed_end_min) : null;
      const time = t.fixed_start_min === null
        ? "frei wählbar"
        : `${clock(t.fixed_start_min)}–${clock(t.fixed_end_min)}${booked > t.fixed_end_min ? `, Puffer bis ${clock(booked)}` : ""}`;
      const terms = isSeriesType(t) ? `${t.series_offsets.length} (${patternText(t)})` : t.first_weekday !== null ? `1 (${D.WEEKDAYS[t.first_weekday]})` : "1";
      tr.append(name, el("td", "muted", hoursText(t)), el("td", "tab", time), el("td", "", terms));
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

  function renderEventList() {
    const tbody = $("#event-list");
    tbody.replaceChildren();
    const sorted = [...data.events].sort((a, b) => a.date.localeCompare(b.date) || a.start_min - b.start_min);
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
      ? `${sorted.length} ${sorted.length === 1 ? "Event" : "Events"} · ${formatHM(brutto)} brutto · ${formatHM(netto)} netto`
      : "";
  }

  function render() {
    $("#btn-new-type").hidden = !ctx.isAdmin();
    renderTypes();
    renderEventList();
  }

  function setData(next) {
    data = next;
    if (!$("#page-events").hidden) render();
  }

  // --- Initialisierung ---

  function init(context) {
    ctx = context;

    const ef = $("#event-form");
    ef.elements.type_id.addEventListener("change", () => applyType({ adjustDate: true }));
    ef.elements.date.addEventListener("input", () => {
      renderSeriesRows();
      updateWeekdayHint();
    });
    ef.elements.pro_id.addEventListener("change", renderSeriesRows);
    ["start", "end"].forEach((n) => ef.elements[n].addEventListener("input", updatePreview));

    ef.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = ef.elements;
      const body = {
        type_id: Number(f.type_id.value),
        pro_id: Number(f.pro_id.value),
        date: f.date.value,
        start_min: f.start.value ? parseClock(f.start.value) : null,
        end_min: f.end.value ? parseClock(f.end.value) : null,
        notiz: f.notiz.value,
      };
      const perTermin = [...document.querySelectorAll("#event-series-rows select")];
      if (!editingEvent && perTermin.length) body.pros = perTermin.map((s) => (s.value ? Number(s.value) : null));
      try {
        const result = await ctx.api(editingEvent ? `/events/${editingEvent.id}` : "/events", {
          method: editingEvent ? "PUT" : "POST",
          body,
        });
        $("#dlg-event").close();
        const count = result.events?.length || 1;
        ctx.toast(editingEvent ? "Event gespeichert" : count > 1 ? `Serie mit ${count} Terminen erstellt` : "Event erstellt");
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
    ["calc", "series_offsets", "first_weekday"].forEach((n) => tf.elements[n].addEventListener("input", updateTypeForm));
    tf.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const { type } = await ctx.api(editingType ? `/event-types/${editingType.id}` : "/event-types", {
          method: editingType ? "PUT" : "POST",
          body: readTypeForm(),
        });
        $("#dlg-type").close();
        ctx.toast(editingType ? `«${type.name}» gespeichert` : `Event-Typ «${type.name}» angelegt`);
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
        ctx.toast(`Event-Typ «${editingType.name}» gelöscht`);
        ctx.reload();
      } catch (err) {
        tf.querySelector(".form-error").textContent = err.message;
      }
    });

    $("#btn-new-event").addEventListener("click", () => openEvent(null));
    $("#btn-new-type").addEventListener("click", () => openType(null));
  }

  window.Events = {
    init, setData, render, openEvent, eventMenu, eventName, minutesOf, lessonEnd,
    plannedByPro, percentOfSoll, formatPercent, formatHM, formatShortHours, clock, typeOf,
  };
})();
