// Jahreskalender mit Schulferien.
(function () {
  const MONTHS = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ];
  const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

  function parseDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function isoKey(date) {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${m}-${d}`;
  }

  function formatDate(iso) {
    return parseDate(iso).toLocaleDateString("de-CH", {
      weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
    });
  }

  // ISO-8601 Kalenderwoche
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  }

  // Map von "YYYY-MM-DD" auf den Ferieneintrag
  function buildHolidayIndex(entries) {
    const index = {};
    for (const entry of entries) {
      const end = parseDate(entry.end);
      for (let d = parseDate(entry.start); d <= end; d.setDate(d.getDate() + 1)) {
        index[isoKey(d)] = entry;
      }
    }
    return index;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderMonth(year, month, holidays, todayKey) {
    const card = el("section", "month");
    card.appendChild(el("h3", "month-title", MONTHS[month]));

    const grid = el("div", "month-grid");
    grid.appendChild(el("span", "wk-head", "KW"));
    for (const wd of WEEKDAYS) grid.appendChild(el("span", "wd-head", wd));

    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7; // Montag = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = Math.ceil((offset + daysInMonth) / 7) * 7;

    for (let i = 0; i < cells; i++) {
      const dayNum = i - offset + 1;
      const date = new Date(year, month, dayNum);

      if (i % 7 === 0) {
        grid.appendChild(el("span", "wk", String(isoWeek(date))));
      }

      if (dayNum < 1 || dayNum > daysInMonth) {
        grid.appendChild(el("span", "day empty"));
        continue;
      }

      const key = isoKey(date);
      const cell = el("span", "day", String(dayNum));
      const weekday = (date.getDay() + 6) % 7;
      if (weekday >= 5) cell.classList.add("weekend");
      if (key === todayKey) cell.classList.add("today");

      const holiday = holidays[key];
      if (holiday) {
        cell.classList.add(holiday.type);
        const prev = new Date(date); prev.setDate(dayNum - 1);
        const next = new Date(date); next.setDate(dayNum + 1);
        if (holidays[isoKey(prev)] !== holiday || weekday === 0 || dayNum === 1) cell.classList.add("range-start");
        if (holidays[isoKey(next)] !== holiday || weekday === 6 || dayNum === daysInMonth) cell.classList.add("range-end");
        cell.title = `${holiday.name}\n${formatDate(holiday.start)} – ${formatDate(holiday.end)}`;
      }
      grid.appendChild(cell);
    }

    card.appendChild(grid);
    return card;
  }

  function renderLegend(year, entries) {
    const list = el("ul", "legend-list");
    for (const entry of entries) {
      if (parseDate(entry.end).getFullYear() < year || parseDate(entry.start).getFullYear() > year) continue;
      const item = el("li", `legend-item ${entry.type}`);
      item.appendChild(el("span", "legend-dot"));
      const text = el("div", "legend-text");
      text.appendChild(el("strong", "", entry.name));
      const range = entry.start === entry.end
        ? formatDate(entry.start)
        : `${formatDate(entry.start)} – ${formatDate(entry.end)}`;
      text.appendChild(el("span", "legend-range", range));
      item.appendChild(text);
      list.appendChild(item);
    }
    return list;
  }

  function render(container, legendContainer, year, entries) {
    const holidays = buildHolidayIndex(entries);
    const todayKey = isoKey(new Date());
    container.replaceChildren();
    for (let m = 0; m < 12; m++) {
      container.appendChild(renderMonth(year, m, holidays, todayKey));
    }
    legendContainer.replaceChildren(renderLegend(year, entries));
  }

  window.Calendar = { render };
})();
