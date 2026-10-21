// Einsatzkalender der Pros: Tag / Woche / Monat / Saison.
// Zeigt die geplanten Events mit Brutto- bzw. Netto-Stunden.
(function () {
  const D = window.Dates;
  const { el } = D;
  const E = window.Events;

  const YEAR = 2027;
  const MIN_DATE = new Date(YEAR, 0, 1);
  const MAX_DATE = new Date(YEAR, 11, 31);
  const DAY_START = 7; // 07:00
  const DAY_END = 21; // 21:00
  const SLOT_PX = 28; // Höhe pro halbe Stunde
  const GRID_TOP = 8; // Abstand oben in der Tagesansicht
  const SNAP_MIN = 15; // Raster beim Aufziehen
  const STORAGE_KEY = "academy.planner";

  const holidays = D.buildHolidayIndex(window.FERIEN_ZUG);

  let pros = [];
  let events = [];
  let byDayPro = new Map(); // "YYYY-MM-DD|proId" → Events
  let state = { range: "week", date: D.mondayOfWeek(YEAR, 1), hidden: new Set(), mode: "brutto" };
  let refs = null;

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved) return;
      if (["day", "week", "month", "season"].includes(saved.range)) state.range = saved.range;
      if (saved.date) state.date = clamp(D.parseDate(saved.date));
      if (Array.isArray(saved.hidden)) state.hidden = new Set(saved.hidden);
      if (["brutto", "netto"].includes(saved.mode)) state.mode = saved.mode;
    } catch {}
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        range: state.range, date: D.isoKey(state.date), hidden: [...state.hidden], mode: state.mode,
      }));
    } catch {}
  }

  function clamp(date) {
    if (date < MIN_DATE) return new Date(MIN_DATE);
    if (date > MAX_DATE) return new Date(MAX_DATE);
    return date;
  }

  function visiblePros() {
    return pros.filter((p) => !state.hidden.has(p.id));
  }

  function setView(range, date) {
    state.range = range;
    if (date) state.date = clamp(date);
    saveState();
    render();
  }

  // --- Events & Summen ---

  function eventsOn(date, proId) {
    return byDayPro.get(`${D.isoKey(date)}|${proId}`) || [];
  }

  function sum(list) {
    return list.reduce((acc, ev) => acc + E.minutesOf(ev, state.mode), 0);
  }

  // Summe über mehrere Tage und die sichtbaren Pros
  function rangeSummary(days, list) {
    let count = 0;
    let minutes = 0;
    for (const day of days) {
      for (const pro of list) {
        const evs = eventsOn(day, pro.id);
        count += evs.length;
        minutes += sum(evs);
      }
    }
    if (!count) return "Noch keine Events geplant";
    return `${count} ${count === 1 ? "Event" : "Events"} · ${E.formatHM(minutes)} ${state.mode}`;
  }

  // Farbstufe 0–6 für Monats- und Saisonzellen
  function heat(minutes, stepMinutes) {
    if (minutes <= 0) return 0;
    return Math.min(6, Math.ceil(minutes / stepMinutes));
  }

  function holidayBadge(date) {
    const h = holidays[D.isoKey(date)];
    if (!h) return null;
    const badge = el("span", h.type === "ferien" ? "badge fer" : "badge hol", h.name);
    badge.title = h.name;
    return badge;
  }

  function cardHead(title, sub, hint) {
    const hd = el("div", "hd");
    hd.appendChild(el("h3", "", title));
    if (sub) hd.appendChild(el("span", "sub", sub));
    if (hint) {
      hd.appendChild(el("span", "spacer"));
      hd.appendChild(el("span", "sub hint", hint));
    }
    return hd;
  }

  function emptyHint(card) {
    const box = el("div", "empty");
    box.textContent = pros.length
      ? "Keine Pros ausgewählt. Wähle oben mindestens einen Pro."
      : "Noch keine Pros erfasst.";
    card.appendChild(box);
  }

  function eventTitle(ev) {
    const t = E.typeOf(ev);
    const lines = [
      `${t?.name || "Event"} · ${E.clock(ev.start_min)}–${E.clock(ev.end_min)}`,
      `Brutto ${E.formatHM(E.minutesOf(ev, "brutto"))} · Netto ${E.formatHM(E.minutesOf(ev, "netto"))}`,
    ];
    if (ev.notiz) lines.push(ev.notiz);
    return lines.join("\n");
  }

  // --- Tagesansicht: eine Spalte pro Pro mit Zeitachse ---

  const minToY = (min) => GRID_TOP + ((min - DAY_START * 60) / 30) * SLOT_PX;
  const yToMin = (y) => DAY_START * 60 + ((y - GRID_TOP) / SLOT_PX) * 30;
  const snap = (min) => Math.round(min / SNAP_MIN) * SNAP_MIN;
  const limit = (min) => Math.max(DAY_START * 60, Math.min(DAY_END * 60, min));

  // Event-Block: Netto-Anteil voll, Puffer (Brutto − Netto) heller
  function eventBlock(ev) {
    const t = E.typeOf(ev);
    const block = el("div", "ev");
    block.style.setProperty("--c", t?.color || "#6a8fd8");
    const top = minToY(Math.max(ev.start_min, DAY_START * 60));
    const bottom = minToY(Math.min(ev.end_min, DAY_END * 60));
    block.style.top = `${top}px`;
    block.style.height = `${Math.max(bottom - top, 12)}px`;
    if (t && t.brutto_min > 0) {
      const nettoPx = (SLOT_PX * t.netto_min) / 30;
      block.style.setProperty("--netto", `${nettoPx}px`);
      block.style.setProperty("--slot", `${SLOT_PX}px`);
    }
    block.title = eventTitle(ev);
    block.append(
      el("b", "", t?.name || "Event"),
      el("span", "", `${E.clock(ev.start_min)}–${E.clock(ev.end_min)}`),
      el("span", "ev-hours", `${E.formatHM(E.minutesOf(ev, "brutto"))} brutto · ${E.formatHM(E.minutesOf(ev, "netto"))} netto`)
    );
    block.addEventListener("pointerdown", (e) => e.stopPropagation());
    block.addEventListener("click", () => E.openEvent(ev));
    return block;
  }

  // Aufziehen oder Klicken in einer Spalte erstellt ein neues Event
  function enableCreate(col, pro, date) {
    col.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const rect = col.getBoundingClientRect();
      const startMin = limit(Math.floor(yToMin(e.clientY - rect.top) / SNAP_MIN) * SNAP_MIN);
      let endMin = startMin;
      let moved = false;
      const ghost = el("div", "ev ghost");
      col.append(ghost);

      const draw = () => {
        const a = Math.min(startMin, endMin);
        const b = Math.max(startMin, endMin);
        ghost.style.top = `${minToY(a)}px`;
        ghost.style.height = `${Math.max(minToY(b) - minToY(a), 4)}px`;
        ghost.textContent = moved ? `${E.clock(a)}–${E.clock(b)}` : "";
      };
      draw();
      col.setPointerCapture(e.pointerId);

      const onMove = (m) => {
        endMin = limit(snap(yToMin(m.clientY - rect.top)));
        if (Math.abs(endMin - startMin) >= SNAP_MIN) moved = true;
        draw();
      };
      const onUp = () => {
        col.removeEventListener("pointermove", onMove);
        col.removeEventListener("pointerup", onUp);
        col.removeEventListener("pointercancel", onUp);
        ghost.remove();
        let a = Math.min(startMin, endMin);
        let b = Math.max(startMin, endMin);
        if (!moved || b - a < SNAP_MIN) {
          // Einfacher Klick: 1 h ab der angeklickten halben Stunde
          a = Math.floor(startMin / 30) * 30;
          b = Math.min(a + 60, DAY_END * 60);
        }
        E.openEvent(null, { pro_id: pro.id, date: D.isoKey(date), start_min: a, end_min: b });
      };
      col.addEventListener("pointermove", onMove);
      col.addEventListener("pointerup", onUp);
      col.addEventListener("pointercancel", onUp);
    });
  }

  function renderDay(card) {
    const date = state.date;
    const list = visiblePros();
    const title = `${D.WEEKDAYS_LONG[D.weekday(date)]}, ${D.formatShort(date)}`;
    const hd = cardHead(title, rangeSummary([date], list), "Aufziehen oder klicken = neues Event · voll = netto, schraffiert = Puffer");
    const badge = holidayBadge(date);
    if (badge) hd.insertBefore(badge, hd.children[1]);
    card.appendChild(hd);

    if (!list.length) return emptyHint(card);

    const slots = (DAY_END - DAY_START) * 2;
    const height = slots * SLOT_PX;
    const grid = el("div", "dv");
    grid.style.gridTemplateColumns = `58px repeat(${list.length}, minmax(140px, 1fr))`;
    grid.style.gridTemplateRows = `auto ${height + 16}px`;

    grid.appendChild(el("div", "colh corner"));
    for (const pro of list) {
      const h = el("div", "colh", pro.name);
      const total = sum(eventsOn(date, pro.id));
      h.appendChild(el("small", "", total ? `${E.formatHM(total)} ${state.mode}` : "frei"));
      grid.appendChild(h);
    }

    const gut = el("div", "gut");
    for (let i = 0; i <= slots; i += 2) {
      const label = el("div", "", `${String(DAY_START + i / 2).padStart(2, "0")}:00`);
      label.style.top = `${GRID_TOP + i * SLOT_PX}px`;
      gut.appendChild(label);
    }
    grid.appendChild(gut);

    for (const pro of list) {
      const col = el("div", "col");
      for (let i = 0; i <= slots; i++) {
        const line = el("div", i % 2 ? "ln h" : "ln");
        line.style.top = `${GRID_TOP + i * SLOT_PX}px`;
        col.appendChild(line);
      }
      for (const ev of eventsOn(date, pro.id)) col.appendChild(eventBlock(ev));
      enableCreate(col, pro, date);
      grid.appendChild(col);
    }
    card.appendChild(grid);
  }

  // --- Wochenansicht: Zeilen = Pros, Spalten = Mo–So ---

  function renderWeek(card) {
    const monday = D.startOfWeek(state.date);
    const days = Array.from({ length: 7 }, (_, i) => D.addDays(monday, i));
    const list = visiblePros();
    card.appendChild(cardHead(`Alle Pros · KW ${D.isoWeek(monday)}`, rangeSummary(days, list), "Klick auf einen Tag = Tagesansicht"));

    if (!list.length) return emptyHint(card);

    const grid = el("div", "wv");
    const corner = el("div", "h corner");
    corner.appendChild(el("b", "", "Pro"));
    corner.appendChild(el("small", "", `Std. ${state.mode}`));
    grid.appendChild(corner);

    for (const day of days) {
      const h = el("div", "h");
      h.appendChild(el("b", "", `${D.WEEKDAYS[D.weekday(day)]} ${day.getDate()}.${day.getMonth() + 1}.`));
      const badge = holidayBadge(day);
      if (badge) h.appendChild(badge);
      h.addEventListener("click", () => setView("day", day));
      grid.appendChild(h);
    }

    for (const pro of list) {
      const weekTotal = days.reduce((acc, day) => acc + sum(eventsOn(day, pro.id)), 0);
      const p = el("div", "p");
      p.append(el("span", "", pro.name), el("small", "", E.formatHM(weekTotal)));
      grid.appendChild(p);
      for (const day of days) {
        const c = el("div", "c");
        if (holidays[D.isoKey(day)]) c.classList.add("hol");
        const evs = eventsOn(day, pro.id);
        if (evs.length) c.appendChild(el("div", "sum", E.formatHM(sum(evs))));
        for (const ev of evs) {
          const t = E.typeOf(ev);
          const row = el("div", "er");
          row.style.setProperty("--c", t?.color || "#6a8fd8");
          row.append(el("span", "tm", E.clock(ev.start_min)), document.createTextNode(` ${t?.name || "Event"}`));
          row.title = eventTitle(ev);
          row.addEventListener("click", (e) => {
            e.stopPropagation();
            E.openEvent(ev);
          });
          c.appendChild(row);
        }
        c.title = `${pro.name} · ${D.formatShort(day)}`;
        c.addEventListener("click", () => setView("day", day));
        grid.appendChild(c);
      }
    }
    card.appendChild(grid);
  }

  function holidayBand(holiday) {
    const band = el("div", "band");
    if (holiday) {
      band.classList.add(holiday.type === "ferien" ? "fer" : "hol");
      band.title = holiday.name;
    }
    return band;
  }

  function heatCell(minutes, stepMinutes, title) {
    const x = el("div", `x h${heat(minutes, stepMinutes)}`, minutes ? E.formatShortHours(minutes) : "");
    x.title = minutes ? `${title} · ${E.formatHM(minutes)} ${state.mode}` : title;
    return x;
  }

  // --- Monatsansicht: Pros × Tage ---

  function renderMonth(card) {
    const year = state.date.getFullYear();
    const month = state.date.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const days = Array.from({ length: daysInMonth }, (_, i) => new Date(year, month, i + 1));
    const list = visiblePros();
    card.appendChild(cardHead(`Monatsübersicht · ${D.MONTHS[month]} ${year}`, rangeSummary(days, list), `Stunden ${state.mode} je Pro und Tag · Klick = Tagesansicht`));

    if (!list.length) return emptyHint(card);

    const grid = el("div", "hm");
    grid.style.gridTemplateColumns = `130px repeat(${daysInMonth}, minmax(30px, 1fr))`;

    grid.appendChild(el("div", "hc"));
    for (const day of days) {
      const hc = el("div", "hc");
      if (D.weekday(day) >= 5) hc.classList.add("we");
      hc.appendChild(el("span", "", D.WEEKDAYS[D.weekday(day)]));
      hc.appendChild(el("b", "", String(day.getDate())));
      hc.addEventListener("click", () => setView("day", day));
      grid.appendChild(hc);
    }

    grid.appendChild(el("div", "pl sm", "Ferien / Feiertag"));
    for (const day of days) grid.appendChild(holidayBand(holidays[D.isoKey(day)]));

    for (const pro of list) {
      grid.appendChild(el("div", "pl", pro.name));
      for (const day of days) {
        const x = heatCell(sum(eventsOn(day, pro.id)), 90, `${pro.name} · ${D.formatShort(day)}`);
        x.addEventListener("click", () => setView("day", day));
        grid.appendChild(x);
      }
    }
    card.appendChild(grid);
  }

  // --- Saisonansicht: Pros × Kalenderwochen ---

  function renderSeason(card) {
    const weeks = D.weeksInYear(YEAR);
    const mondays = Array.from({ length: weeks }, (_, i) => D.mondayOfWeek(YEAR, i + 1));
    const list = visiblePros();
    const allDays = mondays.flatMap((m) => Array.from({ length: 7 }, (_, i) => D.addDays(m, i)));
    card.appendChild(cardHead(`Saison ${YEAR} · Wochenübersicht`, rangeSummary(allDays, list), `Stunden ${state.mode} je Pro und KW · Klick = Wochenansicht`));

    if (!list.length) return emptyHint(card);

    const grid = el("div", "hm season");
    grid.style.gridTemplateColumns = `130px repeat(${weeks}, minmax(14px, 1fr))`;

    grid.appendChild(el("div", "hc"));
    for (const [i, monday] of mondays.entries()) {
      const hc = el("div", "hc", i % 2 === 0 ? String(i + 1) : "");
      hc.title = `KW ${i + 1}`;
      hc.addEventListener("click", () => setView("week", monday));
      grid.appendChild(hc);
    }

    grid.appendChild(el("div", "pl sm", "Ferien"));
    for (const monday of mondays) {
      // Ferien haben Vorrang vor einzelnen schulfreien Tagen.
      const inWeek = Array.from({ length: 7 }, (_, i) => holidays[D.isoKey(D.addDays(monday, i))]).filter(Boolean);
      const holiday = inWeek.find((h) => h.type === "ferien") || inWeek[0];
      grid.appendChild(holidayBand(holiday));
    }

    for (const pro of list) {
      grid.appendChild(el("div", "pl", pro.name));
      for (const [i, monday] of mondays.entries()) {
        const minutes = Array.from({ length: 7 }, (_, d) => sum(eventsOn(D.addDays(monday, d), pro.id))).reduce((a, b) => a + b, 0);
        const x = heatCell(minutes, 8 * 60, `${pro.name} · KW ${i + 1}`);
        x.addEventListener("click", () => setView("week", monday));
        grid.appendChild(x);
      }
    }
    card.appendChild(grid);
  }

  function navLabel() {
    const date = state.date;
    switch (state.range) {
      case "day":
        return `${D.WEEKDAYS_LONG[D.weekday(date)]}, ${D.formatShort(date)} · KW ${D.isoWeek(date)}`;
      case "week": {
        const monday = D.startOfWeek(date);
        const sunday = D.addDays(monday, 6);
        return `KW ${D.isoWeek(monday)} · ${monday.getDate()}.${monday.getMonth() + 1}.–${D.formatShort(sunday)}`;
      }
      case "month":
        return `${D.MONTHS[date.getMonth()]} ${date.getFullYear()}`;
      default:
        return `Saison ${YEAR} · KW 1–${D.weeksInYear(YEAR)}`;
    }
  }

  function step(direction) {
    const d = state.date;
    let next;
    if (state.range === "day") next = D.addDays(d, direction);
    else if (state.range === "week") next = D.addDays(d, 7 * direction);
    else if (state.range === "month") next = new Date(d.getFullYear(), d.getMonth() + direction, 1);
    else return;
    state.date = clamp(next);
    saveState();
    render();
  }

  function renderChips() {
    const box = refs.chips;
    box.replaceChildren(el("span", "t", "Pros"));
    for (const pro of pros) {
      const chip = el("button", "chip", pro.name);
      chip.type = "button";
      chip.classList.toggle("off", state.hidden.has(pro.id));
      chip.setAttribute("aria-pressed", String(!state.hidden.has(pro.id)));
      chip.title = "Klick: ein-/ausblenden · Ctrl+Klick: nur diesen Pro";
      chip.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey) {
          const onlyThis = pros.every((p) => (p.id === pro.id) !== state.hidden.has(p.id));
          state.hidden = onlyThis ? new Set() : new Set(pros.filter((p) => p.id !== pro.id).map((p) => p.id));
        } else if (state.hidden.has(pro.id)) {
          state.hidden.delete(pro.id);
        } else {
          state.hidden.add(pro.id);
        }
        saveState();
        render();
      });
      box.appendChild(chip);
    }
  }

  function render() {
    if (!refs) return;
    refs.seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.range === state.range));
    refs.mode.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.mode));
    refs.label.textContent = navLabel();
    refs.prev.disabled = state.range === "season";
    refs.next.disabled = state.range === "season";
    refs.date.value = D.isoKey(state.date);

    // 1.–3. Januar 2027 gehören noch zur KW 53 von 2026.
    const week = D.isoWeek(state.date);
    refs.kw.value = week <= D.weeksInYear(YEAR) ? String(week) : "";

    renderChips();

    const card = refs.card;
    card.replaceChildren();
    ({ day: renderDay, week: renderWeek, month: renderMonth, season: renderSeason })[state.range](card);
  }

  function init(root) {
    refs = {
      seg: root.querySelector("[data-planner=seg]"),
      mode: root.querySelector("[data-planner=mode]"),
      prev: root.querySelector("[data-planner=prev]"),
      next: root.querySelector("[data-planner=next]"),
      label: root.querySelector("[data-planner=label]"),
      date: root.querySelector("[data-planner=date]"),
      kw: root.querySelector("[data-planner=kw]"),
      chips: root.querySelector("[data-planner=chips]"),
      card: root.querySelector("[data-planner=card]"),
    };
    loadState();

    refs.date.min = D.isoKey(MIN_DATE);
    refs.date.max = D.isoKey(MAX_DATE);
    refs.kw.appendChild(new Option("KW", ""));
    for (let w = 1; w <= D.weeksInYear(YEAR); w++) refs.kw.appendChild(new Option(`KW ${w}`, String(w)));

    refs.seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.range)));
    refs.mode.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        state.mode = b.dataset.mode;
        saveState();
        render();
      })
    );
    refs.prev.addEventListener("click", () => step(-1));
    refs.next.addEventListener("click", () => step(1));
    refs.date.addEventListener("change", () => {
      if (refs.date.value) setView(state.range, D.parseDate(refs.date.value));
    });
    refs.kw.addEventListener("change", () => {
      if (refs.kw.value) setView("week", D.mondayOfWeek(YEAR, Number(refs.kw.value)));
    });
  }

  function setData(next) {
    pros = next.pros;
    events = next.events;
    byDayPro = new Map();
    for (const ev of events) {
      const key = `${ev.date}|${ev.pro_id}`;
      if (!byDayPro.has(key)) byDayPro.set(key, []);
      byDayPro.get(key).push(ev);
    }
    for (const list of byDayPro.values()) list.sort((a, b) => a.start_min - b.start_min);
    const ids = new Set(pros.map((p) => p.id));
    state.hidden = new Set([...state.hidden].filter((id) => ids.has(id)));
    render();
  }

  window.Planner = { init, setData, render };
})();
