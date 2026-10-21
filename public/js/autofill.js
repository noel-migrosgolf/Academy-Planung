// Auslasten: Ziel-Auslastung je Pro per Regler, Kurse automatisch über 2027 verteilen (Server: /api/autofill).
(function () {
  const { el } = window.Dates;
  const $ = (sel) => document.querySelector(sel);

  const AREA_LABELS = [["kurse", "Kurse"], ["bambinitraining", "Bambini"], ["gce_training", "GCE"]];

  let ctx = null; // { api, toast, reload }
  let data = { pros: [], types: [], events: [] };
  const targets = new Map(); // Pro-ID → Ziel in %
  const excluded = new Set(); // abgewählte Typ-IDs
  let results = new Map(); // Pro-Name → Ergebnis der letzten Vorschau/Ausführung
  let busy = false;

  const fixedTypes = () => data.types.filter((t) => t.fixed_start_min !== null);

  function currentPercent(pro) {
    const planned = Events.plannedByPro().get(pro.id)?.brutto || 0;
    return pro.sollstunden ? (planned / 60 / pro.sollstunden) * 100 : 0;
  }

  function renderTypes() {
    const box = $("#af-types");
    box.replaceChildren();
    const types = fixedTypes();
    if (!types.length) box.append(el("span", "note", "Es gibt noch keine Event-Typen mit fester Zeit."));
    for (const t of types) {
      const chip = el("button", `chip${excluded.has(t.id) ? " off" : ""}`);
      chip.type = "button";
      const dot = el("span", "gdot");
      dot.style.background = t.color;
      chip.append(dot, document.createTextNode(t.code ? `${t.code} · ${t.name}` : t.name));
      chip.addEventListener("click", () => {
        excluded.has(t.id) ? excluded.delete(t.id) : excluded.add(t.id);
        results = new Map();
        render();
      });
      box.append(chip);
    }
  }

  function renderPros() {
    const tbody = $("#af-list");
    tbody.replaceChildren();
    for (const pro of data.pros) {
      if (!targets.has(pro.id)) targets.set(pro.id, pro.auslastung_soll_prozent ?? 100);
      const tr = el("tr");
      const areas = AREA_LABELS.filter(([field]) => pro[field]).map(([, label]) => label).join(", ") || "–";
      const now = currentPercent(pro);

      const meter = el("td", "af-now");
      const bar = el("span", "af-bar");
      const fill = el("i");
      fill.style.width = `${Math.min(100, now)}%`;
      bar.append(fill);
      meter.append(bar, el("span", "tab", `${Events.formatPercent(now)}`));

      const goal = el("td", "af-goal");
      const range = el("input");
      Object.assign(range, { type: "range", min: 0, max: 150, step: 5, value: targets.get(pro.id) });
      range.setAttribute("aria-label", `Ziel für ${pro.name}`);
      const value = el("b", "tab", `${targets.get(pro.id)} %`);
      range.addEventListener("input", () => {
        targets.set(pro.id, Number(range.value));
        value.textContent = `${range.value} %`;
        results.delete(pro.name);
        renderResult(resultCell, pro);
      });
      goal.append(range, value);

      const resultCell = el("td", "af-result");
      renderResult(resultCell, pro);
      tr.append(el("td", "", pro.name), el("td", "muted", areas), meter, goal, resultCell);
      tbody.append(tr);
    }
  }

  function renderResult(cell, pro) {
    cell.replaceChildren();
    const r = results.get(pro.name);
    if (!r) return;
    if (r.nachher_prozent !== undefined) {
      const series = Object.entries(r.serien || {}).map(([t, n]) => `${t}×${n}`).join(", ");
      cell.append(el("b", "tab", `→ ${r.nachher_prozent} %`));
      if (series) cell.append(el("span", "muted", ` ${series}`));
    }
    if (r.hinweis) cell.append(el("span", "af-warn", ` ${r.hinweis}`));
  }

  function render() {
    renderTypes();
    renderPros();
    $("#af-preview").disabled = busy;
    $("#af-run").disabled = busy;
  }

  function request(dryRun) {
    return ctx.api("/autofill", {
      method: "POST",
      body: {
        ziele: data.pros.filter((p) => p.sollstunden > 0).map((p) => ({ pro: p.id, prozent: targets.get(p.id) ?? 0 })),
        typen: fixedTypes().filter((t) => !excluded.has(t.id)).map((t) => t.id),
        von: $("#af-from").value || "2027-01-01",
        bis: $("#af-to").value || "2027-12-31",
        freie_tage_beachten: $("#af-free").checked,
        regeln_erfuellen: $("#af-rules").checked,
        dry_run: dryRun,
      },
    });
  }

  async function run(dryRun) {
    if (!fixedTypes().some((t) => !excluded.has(t.id))) return ctx.toast("Bitte mindestens einen Kurs auswählen.");
    busy = true;
    render();
    $("#af-note").textContent = dryRun ? "Vorschau wird berechnet …" : "Kurse werden verteilt …";
    try {
      const r = await request(dryRun);
      results = new Map(r.summary.map((s) => [s.pro, s]));
      renderRuleResults(r.regeln || []);
      $("#af-note").textContent = dryRun
        ? `Vorschau: ${r.count} Termine würden geplant (noch nichts gespeichert).`
        : `${r.count} Termine geplant.`;
      if (!dryRun) {
        ctx.toast(`${r.count} Termine geplant`, r.count ? { label: "Rückgängig", run: () => undo(r.created) } : undefined);
        await ctx.reload();
      }
    } catch (err) {
      $("#af-note").textContent = "";
      ctx.toast(err.message);
    } finally {
      busy = false;
      render();
    }
  }

  // Stand der Regeln nach Vorschau bzw. Ausführen
  function renderRuleResults(list) {
    const box = $("#af-rule-results");
    box.replaceChildren();
    box.hidden = !list.length;
    if (!list.length) return;
    box.append(el("h4", "", "Regeln"));
    for (const g of list) {
      const row = el("div", `rule-row ${g.erfuellt ? "ok" : "bad"}`);
      row.append(el("span", "rule-ic", g.erfuellt ? "✓" : "✗"));
      const main = el("div", "rule-main");
      main.append(el("div", "rule-text", g.regel), el("div", "rule-meter tab", `${g.vorher} → ${g.nachher}`));
      row.append(main);
      box.append(row);
    }
  }

  async function undo(ids) {
    try {
      await ctx.api("/events/bulk-delete", { method: "POST", body: { ids } });
      results = new Map();
      renderRuleResults([]);
      $("#af-note").textContent = "Auslasten rückgängig gemacht.";
      ctx.toast("Auslasten rückgängig gemacht");
      await ctx.reload();
    } catch (err) {
      ctx.toast(err.message);
    }
  }

  function setData(next) {
    data = next;
    if (!$("#page-auslasten").hidden) render();
  }

  function init(context) {
    ctx = context;
    const all = $("#af-all");
    all.addEventListener("input", () => {
      $("#af-all-val").textContent = `${all.value} %`;
      for (const p of data.pros) targets.set(p.id, Number(all.value));
      results = new Map();
      renderPros();
    });
    $("#af-preview").addEventListener("click", () => run(true));
    $("#af-run").addEventListener("click", () => run(false));
    ["#af-free", "#af-rules", "#af-from", "#af-to"].forEach((s) => $(s).addEventListener("change", () => {
      results = new Map();
      renderPros();
    }));
  }

  window.AutoFillPage = { init, setData, render };
})();
