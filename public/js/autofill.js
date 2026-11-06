// Auslasten-Assistent (Server: /api/autofill) in vier Schritten:
//   1 Art: «Pros auslasten» (bis zu 10 Kurstypen priorisieren, übrige füllen auf) oder «Einzelne Kurstypen nachplanen»
//   2 Kurstypen: Priorität bzw. Auswahl mit Anzahl
//   3 Pros & Ziel: Ziel-Auslastung je Pro per Regler
//   4 Zeitraum, Optionen, Vorschau und Ausführen
(function () {
  const { el } = window.Dates;
  const $ = (sel) => document.querySelector(sel);

  const AREA_LABELS = [["kurse", "Kurse"], ["bambinitraining", "Bambini"], ["gce_training", "GCE"]];
  const TYPE_AREAS = { kurse: "Kurse", bambini: "Bambini", gce: "GCE" };
  const MAX_PRIO = 10;

  let ctx = null; // { api, toast, reload }
  let data = { pros: [], types: [], events: [] };
  let mode = null; // "auslasten" | "nachplanen"
  let step = 1;
  const targets = new Map(); // Pro-ID → Ziel in %
  let priority = []; // Typ-IDs, Reihenfolge = Priorität
  const excluded = new Set(); // abgewählte übrige Typ-IDs
  const catchUp = new Map(); // Typ-ID → Anzahl (nur angehakte)
  let results = new Map(); // Pro-Name → Ergebnis der letzten Vorschau/Ausführung
  let typeResults = new Map(); // Typ-Bezeichnung → Ergebnis
  let busy = false;

  const fixedTypes = () => data.types.filter((t) => t.fixed_start_min !== null);
  const typeById = (id) => data.types.find((t) => t.id === id);
  const typeLabel = (t) => (t.code ? `${t.code} · ${t.name}` : t.name);
  const restTypes = () => fixedTypes().filter((t) => !priority.includes(t.id));

  function currentPercent(pro) {
    const planned = Events.plannedByPro().get(pro.id)?.brutto || 0;
    return pro.sollstunden ? (planned / 60 / pro.sollstunden) * 100 : 0;
  }

  // Eine Änderung an der Auswahl macht die letzte Vorschau ungültig
  function invalidate() {
    results = new Map();
    typeResults = new Map();
    renderRuleResults([]);
    $("#af-note").textContent = "";
  }

  function dot(t) {
    const d = el("span", "gdot");
    d.style.background = t.color;
    return d;
  }

  // --- Schritt 1: Art ---

  function renderModes() {
    document.querySelectorAll(".af-mode").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  }

  // --- Schritt 2: Kurstypen ---

  function renderPriority() {
    priority = priority.filter((id) => fixedTypes().some((t) => t.id === id));
    const list = $("#af-prio");
    list.replaceChildren();
    if (!priority.length) list.append(el("li", "af-prio-empty", "Noch keine Priorität – ohne Priorität werden alle gewählten Kurstypen gemischt verteilt."));
    priority.forEach((id, i) => {
      const t = typeById(id);
      const li = el("li");
      const name = el("span", "name");
      name.append(dot(t), document.createTextNode(` ${typeLabel(t)}`));
      li.append(el("span", "n", String(i + 1)), name);
      const button = (label, title, disabled, run) => {
        const b = el("button", "btn sm", label);
        Object.assign(b, { type: "button", title, disabled });
        b.addEventListener("click", () => {
          run();
          invalidate();
          render();
        });
        li.append(b);
      };
      button("↑", "Höher priorisieren", i === 0, () => priority.splice(i - 1, 2, priority[i], priority[i - 1]));
      button("↓", "Tiefer priorisieren", i === priority.length - 1, () => priority.splice(i, 2, priority[i + 1], priority[i]));
      button("✕", "Aus der Priorität entfernen", false, () => priority.splice(i, 1));
      list.append(li);
    });
    const add = $("#af-prio-add");
    const open = restTypes();
    add.replaceChildren(new Option(priority.length >= MAX_PRIO ? "Höchstens 10 Kurstypen" : "+ Kurstyp priorisieren …", ""),
      ...open.map((t) => new Option(typeLabel(t), String(t.id))));
    add.disabled = priority.length >= MAX_PRIO || !open.length;
    $("#af-prio-note").textContent = `${priority.length} von ${MAX_PRIO}`;
  }

  function renderRest() {
    const box = $("#af-types");
    box.replaceChildren();
    const types = restTypes();
    const on = $("#af-rest").checked;
    if (!fixedTypes().length) box.append(el("span", "note", "Es gibt noch keine Kurstypen mit fester Zeit."));
    else if (!types.length) box.append(el("span", "note", "Alle Kurstypen sind priorisiert."));
    for (const t of types) {
      const chip = el("button", `chip${excluded.has(t.id) || !on ? " off" : ""}`);
      Object.assign(chip, { type: "button", disabled: !on });
      chip.append(dot(t), document.createTextNode(typeLabel(t)));
      chip.addEventListener("click", () => {
        excluded.has(t.id) ? excluded.delete(t.id) : excluded.add(t.id);
        invalidate();
        render();
      });
      box.append(chip);
    }
  }

  // Bisher geplant: Anzahl Serien bzw. Einzeltermine und Brutto-Stunden des Typs
  function plannedText(t) {
    const list = data.events.filter((e) => e.type_id === t.id);
    const count = new Set(list.map((e) => e.series_id || `e${e.id}`)).size;
    const hours = list.reduce((sum, e) => sum + Events.minutesOf(e, "brutto"), 0) / 60;
    const h = (v) => v.toLocaleString("de-CH", { maximumFractionDigits: 1 });
    const unit = (t.series_offsets.length > 1 || t.wiederholung === "woechentlich") ? (count === 1 ? "Serie" : "Serien") : count === 1 ? "Termin" : "Termine";
    return `${count} ${unit} · ${h(hours)}${t.max_stunden ? ` / max. ${h(t.max_stunden)}` : ""} h`;
  }

  function renderCatchUp() {
    const tbody = $("#af-catchup");
    tbody.replaceChildren();
    for (const t of fixedTypes()) {
      const tr = el("tr");
      const pick = el("td");
      const box = el("input");
      Object.assign(box, { type: "checkbox", checked: catchUp.has(t.id) });
      box.setAttribute("aria-label", `${t.name} nachplanen`);
      pick.append(box);
      const name = el("td");
      name.append(dot(t), document.createTextNode(` ${typeLabel(t)}`));
      const amount = el("td");
      const input = el("input");
      Object.assign(input, { type: "number", min: 1, max: 500, step: 1, value: catchUp.get(t.id) ?? 1, disabled: !catchUp.has(t.id) });
      input.setAttribute("aria-label", `Anzahl ${t.name}`);
      amount.append(input, el("span", "muted", (t.series_offsets.length > 1 || t.wiederholung === "woechentlich") ? " Serien" : " Termine"));
      box.addEventListener("change", () => {
        box.checked ? catchUp.set(t.id, Math.max(1, Number(input.value) || 1)) : catchUp.delete(t.id);
        input.disabled = !box.checked;
        invalidate();
        renderNav();
      });
      input.addEventListener("input", () => {
        if (catchUp.has(t.id)) catchUp.set(t.id, Math.max(1, Math.round(Number(input.value) || 1)));
        invalidate();
      });
      const result = el("td", "af-result");
      const r = typeResults.get(typeLabel(t));
      if (r) {
        result.append(el("b", "tab", `${r.geplant} / ${r.gewuenscht}`));
        if (r.hinweis) result.append(el("span", "af-warn", ` ${r.hinweis}`));
      }
      tr.append(pick, name, el("td", "", TYPE_AREAS[t.einsatzbereich] || "alle"), el("td", "tab muted", plannedText(t)), amount, result);
      tbody.append(tr);
    }
  }

  // --- Schritt 3: Pros & Ziel ---

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
    $("#af-pros-sub").textContent = mode === "nachplanen"
      ? "Die nachgeplanten Termine gehen an die Pros mit der geringsten Auslastung im Verhältnis zum Ziel; Ziel 0 % = bekommt nichts"
      : "Ziel = geplante Brutto-Stunden in % der Sollstunden";
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

  // --- Schritt 4: Zusammenfassung ---

  function renderSummary() {
    const box = $("#af-summary");
    box.replaceChildren();
    const line = (label, text) => {
      const p = el("div");
      p.append(el("b", "", `${label}: `), document.createTextNode(text));
      box.append(p);
    };
    const names = (ids) => ids.map((id) => typeById(id)).filter(Boolean).map((t) => t.code || t.name);
    if (mode === "nachplanen") {
      line("Nachplanen", [...catchUp].map(([id, n]) => `${names([id])[0]} ×${n}`).join(", ") || "–");
      line("Ziel-Auslastung", $("#af-over").checked ? "darf überschritten werden" : "gilt als Obergrenze");
    } else {
      line("Priorität", priority.length ? names(priority).map((n, i) => `${i + 1}. ${n}`).join(", ") : "keine");
      const rest = restTypes().filter((t) => !excluded.has(t.id)).map((t) => t.id);
      line("Danach auffüllen mit", $("#af-rest").checked ? names(rest).join(", ") || "–" : "nicht auffüllen");
    }
    const goals = data.pros.filter((p) => p.sollstunden > 0).map((p) => `${p.name} ${targets.get(p.id) ?? 0} %`);
    line("Ziele", goals.join(", ") || "–");
  }

  function renderTypeResults() {
    const box = $("#af-type-results");
    box.replaceChildren();
    const list = [...typeResults.values()];
    box.dataset.has = list.length ? "1" : "";
    if (!list.length) return;
    box.append(el("h4", "", mode === "nachplanen" ? "Nachgeplant" : "Priorisierte Kurstypen"));
    for (const r of list) {
      const ok = r.gewuenscht === undefined ? r.geplant > 0 : r.geplant >= r.gewuenscht;
      const row = el("div", `rule-row ${ok ? "ok" : "bad"}`);
      row.append(el("span", "rule-ic", ok ? "✓" : "✗"));
      const main = el("div", "rule-main");
      const title = el("div", "rule-text");
      if (r.prioritaet) title.append(el("span", "rule-id", String(r.prioritaet)));
      title.append(document.createTextNode(r.typ));
      const amount = r.gewuenscht === undefined ? `${r.geplant} verteilt` : `${r.geplant} von ${r.gewuenscht} geplant`;
      main.append(title, el("div", "rule-meter tab", `${amount}${r.hinweis ? ` · ${r.hinweis}` : ""}`));
      row.append(main);
      box.append(row);
    }
  }

  // --- Ablauf ---

  function canEnter(n) {
    if (n >= 2 && !mode) return false;
    if (n >= 3 && mode === "nachplanen" && !catchUp.size) return false;
    if (n >= 3 && mode === "auslasten" && !priority.length && !($("#af-rest").checked && restTypes().some((t) => !excluded.has(t.id)))) return false;
    return true;
  }

  function renderNav() {
    document.querySelectorAll("#af-steps button").forEach((b) => {
      const n = Number(b.dataset.step);
      b.classList.toggle("on", n === step);
      b.classList.toggle("done", n < step);
      b.disabled = !canEnter(n);
    });
    document.querySelectorAll("#page-auslasten .af-step").forEach((card) => {
      const forMode = card.dataset.for;
      let hidden = Number(card.dataset.step) !== step || (forMode && forMode !== mode);
      if (card.id === "af-rule-results") hidden ||= !card.dataset.has;
      if (card.id === "af-type-results") hidden ||= !card.dataset.has;
      card.hidden = hidden;
    });
    document.querySelectorAll("#page-auslasten [data-for]:not(.af-step)").forEach((x) => { x.hidden = x.dataset.for !== mode; });
    const last = step === 4;
    $("#af-back").hidden = step === 1;
    $("#af-next").hidden = last;
    $("#af-next").disabled = !canEnter(step + 1);
    $("#af-next").title = step === 2 && !canEnter(3)
      ? mode === "nachplanen" ? "Bitte mindestens einen Kurstyp anhaken." : "Bitte mindestens einen Kurstyp priorisieren oder übrige auswählen."
      : "";
    $("#af-preview").hidden = !last;
    $("#af-run").hidden = !last;
    $("#af-clear").hidden = !last || !PlansUI.canEdit();
    $("#af-preview").disabled = busy;
    $("#af-run").disabled = busy || !PlansUI.canEdit();
    $("#af-run").title = PlansUI.canEdit() ? "" : "Dieser Plan ist für dich nur zum Ansehen freigegeben.";
    $("#af-clear").disabled = busy;
  }

  function render() {
    renderModes();
    if (step === 2) mode === "nachplanen" ? renderCatchUp() : (renderPriority(), renderRest());
    if (step === 3) renderPros();
    if (step === 4) {
      renderSummary();
      renderTypeResults();
    }
    renderNav();
  }

  function goTo(n) {
    if (!canEnter(n)) return;
    step = n;
    render();
  }

  // Alle Termine des Plans im Zeitraum löschen; Bestätigung in zwei Klicks, danach «Rückgängig».
  let clearTimer = null;
  async function clearAll() {
    const btn = $("#af-clear");
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = "1";
      btn.textContent = "Wirklich alles entfernen?";
      clearTimer = setTimeout(() => {
        delete btn.dataset.confirm;
        btn.textContent = "Alles entfernen";
      }, 4000);
      return;
    }
    clearTimeout(clearTimer);
    delete btn.dataset.confirm;
    btn.textContent = "Alles entfernen";
    busy = true;
    render();
    try {
      const r = await ctx.api("/events/clear", { method: "POST", body: { von: $("#af-from").value, bis: $("#af-to").value } });
      invalidate();
      $("#af-note").textContent = `${r.count} Termine entfernt.`;
      ctx.toast(`${r.count} Termine entfernt`, r.undo_token ? { label: "Rückgängig", run: () => undo(r.undo_token) } : undefined);
      await ctx.reload();
    } catch (err) {
      ctx.toast(err.message);
    } finally {
      busy = false;
      render();
    }
  }

  function request(dryRun) {
    const body = {
      ziele: data.pros.filter((p) => p.sollstunden > 0).map((p) => ({ pro: p.id, prozent: targets.get(p.id) ?? 0 })),
      von: $("#af-from").value || "2027-01-01",
      bis: $("#af-to").value || "2027-12-31",
      freie_tage_beachten: $("#af-free").checked,
      regeln_erfuellen: $("#af-rules").checked,
      dry_run: dryRun,
    };
    if (mode === "nachplanen") {
      body.nachplanen = [...catchUp].map(([typ, anzahl]) => ({ typ, anzahl }));
      body.ziel_ueberschreiten = $("#af-over").checked;
    } else {
      const rest = restTypes().filter((t) => !excluded.has(t.id)).map((t) => t.id);
      body.prioritaet = priority;
      body.uebrige = $("#af-rest").checked && rest.length > 0;
      if (body.uebrige) body.typen = rest;
    }
    return ctx.api("/autofill", { method: "POST", body });
  }

  async function run(dryRun) {
    busy = true;
    render();
    $("#af-note").textContent = dryRun ? "Vorschau wird berechnet …" : "Kurse werden verteilt …";
    try {
      const r = await request(dryRun);
      results = new Map(r.summary.map((s) => [s.pro, s]));
      typeResults = new Map((r.typen_ergebnis || []).map((t) => [t.typ, t]));
      renderRuleResults(r.regeln || []);
      $("#af-note").textContent = dryRun
        ? `Vorschau: ${r.count} Termine würden geplant (noch nichts gespeichert). Ergebnis je Pro unter «3 Pros & Ziel».`
        : `${r.count} Termine geplant.`;
      if (!dryRun) {
        ctx.toast(`${r.count} Termine geplant`, r.count ? { label: "Rückgängig", run: () => undo(r.undo_token) } : undefined);
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
    box.dataset.has = list.length ? "1" : "";
    if (!list.length) return;
    box.append(el("h4", "", "Regeln"));
    for (const g of list) {
      const row = el("div", `rule-row ${g.erfuellt ? "ok" : "bad"}`);
      row.append(el("span", "rule-ic", g.erfuellt ? "✓" : "✗"));
      const main = el("div", "rule-main");
      const title = el("div", "rule-text");
      title.append(el("span", "rule-id", g.id), document.createTextNode(g.regel));
      main.append(title, el("div", "rule-meter tab", `${g.vorher} → ${g.nachher}`));
      row.append(main);
      box.append(row);
    }
  }

  async function undo(token) {
    try {
      await ctx.api(`/undo/${token}`, { method: "POST" });
      invalidate();
      $("#af-note").textContent = "Rückgängig gemacht.";
      ctx.toast("Rückgängig gemacht");
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
    document.querySelectorAll(".af-mode").forEach((b) => b.addEventListener("click", () => {
      if (mode !== b.dataset.mode) invalidate();
      mode = b.dataset.mode;
      goTo(2);
    }));
    document.querySelectorAll("#af-steps button").forEach((b) => b.addEventListener("click", () => goTo(Number(b.dataset.step))));
    $("#af-back").addEventListener("click", () => goTo(step - 1));
    $("#af-next").addEventListener("click", () => goTo(step + 1));
    $("#af-prio-add").addEventListener("change", (e) => {
      const id = Number(e.target.value);
      if (id && priority.length < MAX_PRIO && !priority.includes(id)) {
        priority.push(id);
        excluded.delete(id);
      }
      invalidate();
      render();
    });
    $("#af-rest").addEventListener("change", () => {
      invalidate();
      render();
    });
    const all = $("#af-all");
    all.addEventListener("input", () => {
      $("#af-all-val").textContent = `${all.value} %`;
      for (const p of data.pros) targets.set(p.id, Number(all.value));
      invalidate();
      renderPros();
    });
    $("#af-preview").addEventListener("click", () => run(true));
    $("#af-run").addEventListener("click", () => run(false));
    $("#af-clear").addEventListener("click", clearAll);
    ["#af-free", "#af-rules", "#af-from", "#af-to", "#af-over"].forEach((s) => $(s).addEventListener("change", () => {
      invalidate();
      render();
    }));
  }

  window.AutoFillPage = { init, setData, render };
})();
