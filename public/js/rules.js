// Regeln (Reiter «Regeln»), zwei Arten:
//   stunden    – «Zwischen Datum x und y müssen <Vergleich> z Sollstunden von Kurs k stattfinden.»
//   wochentage – «Mindestens x % der Sollstunden von Kursen … müssen an Tagen … stattfinden.»
// Regeln gehören zum aktuellen Plan; anlegen, bearbeiten, (de)aktivieren und löschen darf, wer den Plan bearbeiten darf.
(function () {
  const { el } = window.Dates;
  const $ = (sel) => document.querySelector(sel);

  let ctx = null; // { api, toast, canEdit }
  let data = { types: [] };
  let rules = [];
  let editing = null;
  let kind = "stunden";
  const selTypes = new Set();
  const selDays = new Set();

  const hours = (v) => `${Number(v).toLocaleString("de-CH", { maximumFractionDigits: 1 })} h`;
  const percent = (v) => `${Number(v).toLocaleString("de-CH", { maximumFractionDigits: 1 })} %`;

  // Abstand zum Ziel in Worten, z. B. «fehlen 12 h», «6 h zu viel» oder «fehlen 8 Prozentpunkte»
  function gapText(r) {
    if (!r.aktiv) return "inaktiv";
    if (r.art === "wochentage") {
      if (r.ist_prozent === null) return "noch nichts geplant";
      return r.erfuellt ? "erfüllt" : `fehlen ${(r.prozent - r.ist_prozent).toLocaleString("de-CH", { maximumFractionDigits: 1 })} Prozentpunkte`;
    }
    const diff = r.ist_stunden - r.stunden;
    if (r.erfuellt) return "erfüllt";
    if (r.operator === "max" || (r.operator === "eq" && diff > 0)) return `${hours(diff)} zu viel`;
    if (r.operator === "gt") return `noch über ${hours(-diff)} nötig`;
    return `fehlen ${hours(-diff)}`;
  }

  function meterOf(r) {
    if (r.art === "wochentage") {
      return {
        fill: r.prozent ? ((r.ist_prozent ?? 0) / r.prozent) * 100 : 100,
        text: r.ist_prozent === null
          ? `mind. ${percent(r.prozent)}`
          : `${percent(r.ist_prozent)} / mind. ${percent(r.prozent)} (${hours(r.stunden_an_tagen)} von ${hours(r.stunden_total)})`,
      };
    }
    return {
      fill: r.stunden ? (r.ist_stunden / r.stunden) * 100 : 100,
      text: `${hours(r.ist_stunden)} / ${hours(r.stunden)}`,
    };
  }

  function renderList() {
    const box = $("#rule-list");
    box.replaceChildren();
    $("#rule-count").textContent = rules.length
      ? `${rules.filter((r) => r.aktiv && r.erfuellt).length} von ${rules.filter((r) => r.aktiv).length} aktiven erfüllt`
      : "";
    if (!rules.length) {
      box.append(el("p", "empty", ctx.canEdit() ? "Noch keine Regeln. Lege oben die erste an." : "Noch keine Regeln."));
      return;
    }
    for (const r of rules) {
      const row = el("div", `rule-row${r.aktiv ? "" : " off"}${r.erfuellt ? " ok" : " bad"}`);
      row.append(el("span", "rule-ic", !r.aktiv ? "–" : r.erfuellt ? "✓" : "✗"));
      const main = el("div", "rule-main");
      const title = el("div", "rule-text");
      title.append(el("span", "rule-id", `R${r.id}`), document.createTextNode(r.text));
      main.append(title);
      const m = meterOf(r);
      const meter = el("div", "rule-meter");
      const bar = el("span", "af-bar");
      const fill = el("i");
      fill.style.width = `${Math.max(0, Math.min(100, m.fill))}%`;
      bar.append(fill);
      meter.append(bar, el("span", "tab", m.text), el("span", "rule-gap", gapText(r)));
      main.append(meter);
      const why = el("div", "rule-why");
      why.hidden = true;
      main.append(why);
      row.append(main);
      const actions = el("div", "rule-actions");
      const whyBtn = el("button", "btn sm", "Warum?");
      whyBtn.type = "button";
      whyBtn.title = "Stand, Hindernisse und Lösung anzeigen";
      whyBtn.addEventListener("click", () => toggleWhy(r, why));
      actions.append(whyBtn);
      row.append(actions);
      if (ctx.canEdit()) {
        const button = (label, cls, run) => {
          const b = el("button", `btn sm${cls}`, label);
          b.type = "button";
          b.addEventListener("click", run);
          actions.append(b);
        };
        button(r.aktiv ? "Deaktivieren" : "Aktivieren", "", () => save({ ...bodyOf(r), aktiv: !r.aktiv }, r.id));
        button("Bearbeiten", "", () => startEdit(r));
        button("Löschen", " danger", () => remove(r));
      }
      box.append(row);
    }
  }

  async function toggleWhy(r, box) {
    if (!box.hidden) {
      box.hidden = true;
      return;
    }
    try {
      const { lines } = await ctx.api(`/rules/${r.id}/check`);
      box.replaceChildren(...lines.slice(1).map((line) => el("div", "", line)));
      box.hidden = false;
    } catch (err) {
      ctx.toast(err.message);
    }
  }

  // Felder einer Regel, wie sie die API erwartet
  function bodyOf(r) {
    return {
      art: r.art, type_id: r.type_id, type_ids: r.type_ids, von: r.von, bis: r.bis, operator: r.operator,
      stunden: r.stunden, prozent: r.prozent, wochentage: r.wochentage, aktiv: r.aktiv, notiz: r.notiz,
    };
  }

  // --- Formular ---

  function setKind(next) {
    kind = next;
    document.querySelectorAll("#rule-kind button").forEach((b) => b.classList.toggle("on", b.dataset.art === kind));
    $("#rule-s-stunden").hidden = kind !== "stunden";
    $("#rule-s-wochentage").hidden = kind !== "wochentage";
    $("#rule-form .form-error").textContent = "";
  }

  function renderTypeChips() {
    const box = $("#rule-types");
    box.replaceChildren();
    for (const t of data.types) {
      const chip = el("button", `chip${selTypes.has(t.id) ? " sel" : ""}`, t.code ? `${t.code} · ${t.name}` : t.name);
      chip.type = "button";
      chip.addEventListener("click", () => {
        selTypes.has(t.id) ? selTypes.delete(t.id) : selTypes.add(t.id);
        renderTypeChips();
      });
      box.append(chip);
    }
  }

  function renderDayChips() {
    const key = [...selDays].sort().join(",");
    document.querySelectorAll("#rule-days [data-day]").forEach((b) => b.classList.toggle("sel", selDays.has(Number(b.dataset.day))));
    document.querySelectorAll("#rule-days [data-preset]").forEach((b) => b.classList.toggle("sel", b.dataset.preset === key));
  }

  function fillTypes() {
    const select = $("#rule-form").elements.type_id;
    const current = select.value;
    select.replaceChildren(...data.types.map((t) => new Option(t.code ? `${t.code} · ${t.name}` : t.name, String(t.id))));
    if (current) select.value = current;
    renderTypeChips();
  }

  function startEdit(r) {
    editing = r;
    setKind(r.art);
    const f = $("#rule-form").elements;
    if (r.art === "wochentage") {
      f.prozent.value = r.prozent;
      selTypes.clear();
      r.type_ids.forEach((id) => selTypes.add(id));
      selDays.clear();
      r.wochentage.forEach((d) => selDays.add(d));
      renderTypeChips();
      renderDayChips();
    } else {
      f.von.value = r.von;
      f.bis.value = r.bis;
      f.operator.value = r.operator;
      f.stunden.value = r.stunden;
      f.type_id.value = String(r.type_id);
    }
    $("#rule-form-title").textContent = "Regel bearbeiten";
    $("#rule-submit").textContent = "Speichern";
    $("#rule-cancel").hidden = false;
    $("#rule-form-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetForm() {
    editing = null;
    const f = $("#rule-form").elements;
    $("#rule-form .form-error").textContent = "";
    f.stunden.value = "";
    f.prozent.value = "";
    selTypes.clear();
    selDays.clear();
    renderTypeChips();
    renderDayChips();
    $("#rule-form-title").textContent = "Neue Regel";
    $("#rule-submit").textContent = "Regel anlegen";
    $("#rule-cancel").hidden = true;
  }

  function readForm() {
    const f = $("#rule-form").elements;
    const base = { aktiv: editing ? editing.aktiv : true, notiz: editing?.notiz || "" };
    if (kind === "wochentage") {
      return {
        ...base,
        art: "wochentage",
        prozent: f.prozent.value === "" ? null : Number(f.prozent.value),
        type_ids: [...selTypes],
        wochentage: [...selDays].sort(),
      };
    }
    return {
      ...base,
      art: "stunden",
      von: f.von.value,
      bis: f.bis.value,
      operator: f.operator.value,
      stunden: f.stunden.value === "" ? null : Number(f.stunden.value),
      type_id: Number(f.type_id.value),
    };
  }

  // --- Speichern ---

  async function save(rule, id) {
    try {
      await ctx.api(id ? `/rules/${id}` : "/rules", { method: id ? "PUT" : "POST", body: rule });
      await load();
    } catch (err) {
      ctx.toast(err.message);
    }
  }

  async function remove(r) {
    try {
      await ctx.api(`/rules/${r.id}`, { method: "DELETE" });
      ctx.toast("Regel gelöscht", { label: "Rückgängig", run: () => save(bodyOf(r)) });
      if (editing?.id === r.id) resetForm();
      await load();
    } catch (err) {
      ctx.toast(err.message);
    }
  }

  async function load() {
    try {
      ({ rules } = await ctx.api("/rules"));
    } catch (err) {
      ctx.toast(err.message);
    }
    renderList();
  }

  function show() {
    $("#rule-form-card").hidden = !ctx.canEdit();
    fillTypes();
    load();
  }

  function setData(next) {
    data = next;
    if (!$("#page-regeln").hidden) show();
  }

  function init(context) {
    ctx = context;
    const form = $("#rule-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await ctx.api(editing ? `/rules/${editing.id}` : "/rules", { method: editing ? "PUT" : "POST", body: readForm() });
        ctx.toast(editing ? "Regel gespeichert" : "Regel angelegt");
        resetForm();
        await load();
      } catch (err) {
        form.querySelector(".form-error").textContent = err.message;
      }
    });
    $("#rule-cancel").addEventListener("click", resetForm);
    document.querySelectorAll("#rule-kind button").forEach((b) =>
      b.addEventListener("click", () => {
        if (editing && editing.art !== b.dataset.art) resetForm();
        setKind(b.dataset.art);
      })
    );
    document.querySelectorAll("#rule-days [data-day]").forEach((b) =>
      b.addEventListener("click", () => {
        const day = Number(b.dataset.day);
        selDays.has(day) ? selDays.delete(day) : selDays.add(day);
        renderDayChips();
      })
    );
    document.querySelectorAll("#rule-days [data-preset]").forEach((b) =>
      b.addEventListener("click", () => {
        selDays.clear();
        b.dataset.preset.split(",").forEach((d) => selDays.add(Number(d)));
        renderDayChips();
      })
    );
  }

  window.RulesPage = { init, setData, show };
})();
