// Events: Brutto/Netto-Berechnung, Event-Dialog und Events-Seite.
(function () {
  const D = window.Dates;
  const { el } = D;
  const $ = (sel) => document.querySelector(sel);

  let ctx = null; // { api, toast, reload, isAdmin }
  let data = { pros: [], types: [], events: [] };
  let editingEvent = null;
  let editingType = null;

  // --- Berechnung ---

  function typeOf(ev) {
    return data.types.find((t) => t.id === ev.type_id);
  }

  // Brutto bzw. Netto in Minuten (Typ-Angaben gelten pro 30 min geplanter Zeit)
  function minutesOf(ev, mode) {
    const t = typeOf(ev);
    if (!t) return 0;
    const per30 = mode === "netto" ? t.netto_min : t.brutto_min;
    return ((ev.end_min - ev.start_min) * per30) / 30;
  }

  // Ende des Unterrichts: Der Unterricht beginnt pünktlich, der ganze Puffer
  // (Brutto − Netto) liegt am Ende des Events.
  function lessonEnd(ev) {
    return Math.round(ev.start_min + minutesOf(ev, "netto"));
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

  // --- Event-Dialog ---

  function fillSelect(select, items, label) {
    select.replaceChildren(...items.map((i) => new Option(label(i), String(i.id))));
  }

  function updatePreview() {
    const f = $("#event-form").elements;
    const start = f.start.value ? parseClock(f.start.value) : 0;
    const end = f.end.value ? parseClock(f.end.value) : 0;
    const t = data.types.find((x) => String(x.id) === f.type_id.value);
    const box = $("#event-preview");
    if (!t || end <= start) {
      box.textContent = "";
      return;
    }
    const ev = { type_id: t.id, start_min: start, end_min: end };
    const lesson = lessonEnd(ev);
    box.replaceChildren(
      el("span", "", `Brutto ${formatHM(minutesOf(ev, "brutto"))}`),
      el("span", "", `Netto ${formatHM(minutesOf(ev, "netto"))}`),
      el("span", "", `Unterricht ${clock(start)}–${clock(lesson)}`)
    );
    if (lesson < end) box.append(el("span", "", `Puffer ${clock(lesson)}–${clock(end)}`));
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
    $("#event-title").textContent = event ? "Event bearbeiten" : "Neues Event";
    $("#event-delete").hidden = !event;

    const f = form.elements;
    fillSelect(f.type_id, data.types, (t) => t.name);
    fillSelect(f.pro_id, data.pros, (p) => p.name);
    const v = event || prefill;
    f.type_id.value = String(v.type_id || data.types[0].id);
    f.pro_id.value = String(v.pro_id || data.pros[0].id);
    f.date.value = v.date || D.isoKey(new Date(2027, 0, 4));
    f.start.value = clock(v.start_min ?? 9 * 60);
    f.end.value = clock(v.end_min ?? 10 * 60);
    f.notiz.value = v.notiz || "";
    updatePreview();
    $("#dlg-event").showModal();
  }

  async function deleteEvent(ev) {
    const t = typeOf(ev);
    const label = `${t?.name || "Event"} ${D.formatDate(ev.date)}, ${clock(ev.start_min)}–${clock(ev.end_min)} (${proName(ev.pro_id)})`;
    if (!confirm(`Event löschen?\n${label}`)) return false;
    await ctx.api(`/events/${ev.id}`, { method: "DELETE" });
    ctx.toast("Event gelöscht");
    ctx.reload();
    return true;
  }

  // Rechtsklick-Menü für ein bestehendes Event
  function eventMenu(e, ev) {
    const t = typeOf(ev);
    ContextMenu.open(e, [
      { label: "Bearbeiten", hint: `${t?.name || "Event"} · ${clock(ev.start_min)}–${clock(ev.end_min)}`, action: () => openEvent(ev) },
      {
        label: "Löschen",
        danger: true,
        action: () => deleteEvent(ev).catch((err) => ctx.toast(err.message)),
      },
    ]);
  }

  // --- Event-Typ-Dialog (Admin) ---

  function openType(type) {
    editingType = type || null;
    const form = $("#type-form");
    form.reset();
    form.querySelector(".form-error").textContent = "";
    $("#type-title").textContent = type ? `${type.name} bearbeiten` : "Neuer Event-Typ";
    $("#type-delete").hidden = !type;
    const f = form.elements;
    f.name.value = type?.name || "";
    f.brutto_min.value = type?.brutto_min ?? 30;
    f.netto_min.value = type?.netto_min ?? 25;
    f.color.value = type?.color || "#6a8fd8";
    $("#dlg-type").showModal();
  }

  // --- Events-Seite ---

  function perHour(t) {
    const ev = { type_id: t.id, start_min: 0, end_min: 60 };
    return `1 h = ${formatHM(minutesOf(ev, "brutto"))} brutto · ${formatHM(minutesOf(ev, "netto"))} netto`;
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
      tr.append(name, el("td", "num", `${t.brutto_min} min`), el("td", "num", `${t.netto_min} min`), el("td", "muted", perHour(t)));
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
      typeCell.append(dot, document.createTextNode(t?.name || "–"));
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
    ["type_id", "start", "end"].forEach((n) => ef.elements[n].addEventListener("input", updatePreview));
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
      try {
        await ctx.api(editingEvent ? `/events/${editingEvent.id}` : "/events", {
          method: editingEvent ? "PUT" : "POST",
          body,
        });
        $("#dlg-event").close();
        ctx.toast(editingEvent ? "Event gespeichert" : "Event erstellt");
        ctx.reload();
      } catch (err) {
        ef.querySelector(".form-error").textContent = err.message;
      }
    });
    $("#event-delete").addEventListener("click", async () => {
      if (!editingEvent) return;
      try {
        if (await deleteEvent(editingEvent)) $("#dlg-event").close();
      } catch (err) {
        ef.querySelector(".form-error").textContent = err.message;
      }
    });

    const tf = $("#type-form");
    tf.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = tf.elements;
      try {
        const { type } = await ctx.api(editingType ? `/event-types/${editingType.id}` : "/event-types", {
          method: editingType ? "PUT" : "POST",
          body: { name: f.name.value, brutto_min: Number(f.brutto_min.value), netto_min: Number(f.netto_min.value), color: f.color.value },
        });
        $("#dlg-type").close();
        ctx.toast(editingType ? `«${type.name}» gespeichert` : `Event-Typ «${type.name}» angelegt`);
        ctx.reload();
      } catch (err) {
        tf.querySelector(".form-error").textContent = err.message;
      }
    });
    $("#type-delete").addEventListener("click", async () => {
      if (!editingType || !confirm(`Event-Typ «${editingType.name}» wirklich löschen?`)) return;
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

  window.Events = { init, setData, render, openEvent, eventMenu, minutesOf, lessonEnd, formatHM, formatShortHours, clock, typeOf };
})();
