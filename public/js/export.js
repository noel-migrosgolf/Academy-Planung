// Export des aktuellen Plans als Excel (.xlsx), PDF oder JSON (Server: GET /api/plan-export).
// Dialog mit Format, Zeitraum und optional einem Pro (z. B. als Einsatzplan); die Datei wird heruntergeladen.
(function () {
  const $ = (sel) => document.querySelector(sel);

  let ctx = null; // { toast, planId, pros }
  let format = "xlsx";

  const NOTES = {
    xlsx: "Excel-Datei mit den Blättern Kurse, Kursanzahl, Pros, Regeln und Info (filterbar).",
    pdf: "PDF im A4-Querformat: Auslastung der Pros, Kursanzahl je Kurstyp, alle Kurse nach Monat und Regeln.",
    json: "Dieselben Daten als JSON, z. B. für andere Programme.",
  };

  function setFormat(next) {
    format = next;
    document.querySelectorAll("#export-format button").forEach((b) => b.classList.toggle("on", b.dataset.format === format));
    $("#export-note").textContent = NOTES[format];
  }

  function open() {
    const form = $("#export-form");
    form.querySelector(".form-error").textContent = "";
    const select = form.elements.pro;
    const current = select.value;
    select.replaceChildren(new Option("Alle Pros", ""), ...ctx.pros().map((p) => new Option(p.name, String(p.id))));
    select.value = [...select.options].some((o) => o.value === current) ? current : "";
    setFormat(format);
    $("#dlg-export").showModal();
  }

  // Dateiname aus «Content-Disposition» (filename*=UTF-8''…)
  function nameFrom(res, fallback) {
    const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("Content-Disposition") || "");
    return m ? decodeURIComponent(m[1]) : fallback;
  }

  async function download(e) {
    e.preventDefault();
    const form = $("#export-form");
    const f = form.elements;
    const error = form.querySelector(".form-error");
    const button = form.querySelector("button[type=submit]");
    error.textContent = "";
    const params = new URLSearchParams({ format, plan: String(ctx.planId()) });
    if (f.von.value) params.set("von", f.von.value);
    if (f.bis.value) params.set("bis", f.bis.value);
    if (f.pro.value) params.set("pro", f.pro.value);
    button.disabled = true;
    button.textContent = "Wird erstellt …";
    try {
      const res = await fetch(`/api/plan-export?${params}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Export fehlgeschlagen.");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = nameFrom(res, `Kursplanung.${format}`);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      $("#dlg-export").close();
      ctx.toast(`Export erstellt: ${a.download}`);
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = "Herunterladen";
    }
  }

  function init(context) {
    ctx = context;
    document.querySelectorAll("[data-export]").forEach((b) => b.addEventListener("click", open));
    document.querySelectorAll("#export-format button").forEach((b) => b.addEventListener("click", () => setFormat(b.dataset.format)));
    $("#export-form").addEventListener("submit", download);
  }

  window.ExportUI = { init };
})();
