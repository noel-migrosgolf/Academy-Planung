// Gemeinsame Datums-Helfer.
(function () {
  const MONTHS = [
    "Januar", "Februar", "März", "April", "Mai", "Juni",
    "Juli", "August", "September", "Oktober", "November", "Dezember",
  ];
  const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  const WEEKDAYS_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

  function parseDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function isoKey(date) {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${m}-${d}`;
  }

  function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  // Wochentag mit Montag = 0
  function weekday(date) {
    return (date.getDay() + 6) % 7;
  }

  function startOfWeek(date) {
    return addDays(date, -weekday(date));
  }

  // ISO-8601 Kalenderwoche
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  }

  // Montag der ISO-Kalenderwoche
  function mondayOfWeek(year, week) {
    const jan4 = new Date(year, 0, 4);
    return addDays(startOfWeek(jan4), (week - 1) * 7);
  }

  // Anzahl ISO-Wochen im Jahr (52 oder 53)
  function weeksInYear(year) {
    return isoWeek(new Date(year, 11, 28));
  }

  function formatDate(iso) {
    return parseDate(iso).toLocaleDateString("de-CH", {
      weekday: "short", day: "2-digit", month: "2-digit", year: "numeric",
    });
  }

  // "24.05.2027"
  function formatShort(date) {
    return date.toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  // Map von "YYYY-MM-DD" auf den Ferieneintrag
  function buildHolidayIndex(entries) {
    const index = {};
    for (const entry of entries) {
      const end = parseDate(entry.end);
      for (let d = parseDate(entry.start); d <= end; d = addDays(d, 1)) {
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

  window.Dates = {
    MONTHS, WEEKDAYS, WEEKDAYS_LONG,
    parseDate, isoKey, addDays, weekday, startOfWeek, isoWeek, mondayOfWeek, weeksInYear,
    formatDate, formatShort, buildHolidayIndex, el,
  };
})();
