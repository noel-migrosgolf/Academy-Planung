// Regeln: «Zwischen Datum x und y müssen <Vergleich> z Sollstunden von Kurs k stattfinden.»
// Anlegen, bearbeiten, (de)aktivieren und löschen nur für Admins; der Stand wird für alle angezeigt.
(function () {
  const { el } = window.Dates;
  const $ = (sel) => document.querySelector(sel);

  let ctx = null; // { api, toast, isAdmin }
  let data = { types: [] };
  let rules = [];
  let editing = null;

  const hours = (v) => `${Number(v).toLocaleString("de-CH", { maximumFractionDigits: 1 })} h`;

  // Abstand zum Ziel in Worten, z. B. «fehlen 12 h» oder «6 h zu viel»
  function gapText(r) {
    const diff = r.ist_stunden - r.stunden;
    if (r.erfuellt) return "erfüllt";
    if (r.operator === "max" || (r.operator === "eq" && diff > 0)) return `${hours(diff)} zu viel`;
    if (r.operator === "gt") return `noch über ${hours(-diff)} nötig`;
    return `fehlen ${hours(-diff)}`;
  }

  function renderList() {
    const box = $("#rule-list");
    box.replaceChildren();
    $("#rule-count").textContent = rules.length
      ? `${rules.filter((r) => r.aktiv && r.erfuellt).length} von ${rules.filter((r) => r.aktiv).length} aktiven erfüllt`
      : "";
    if (!rules.length) {
      box.append(el("p", "empty", ctx.isAdmin() ? "Noch keine Regeln. Lege oben die erste an." : "Noch keine Regeln."));
      return;
    }
    for (const r of rules) {
      const row = el("div", `rule-row${r.aktiv ? "" : " off"}${r.erfuellt ? " ok" : " bad"}`);
      row.append(el("span", "rule-ic", !r.aktiv ? "–" : r.erfuellt ? "✓" : "✗"));
      const main = el("div", "rule-main");
      main.append(el("div", "rule-text", r.text));
      const meter = el("div", "rule-meter");
      const bar = el("span", "af-bar");
      const fill = el("i");
      fill.style.width = `${Math.min(100, r.stunden ? (r.ist_stunden / r.stunden) * 100 : 100)}%`;
      bar.append(fill);
      meter.append(bar, el("span", "tab", `${hours(r.ist_stunden)} / ${hours(r.stunden)}`),
        el("span", "rule-gap", r.aktiv ? gapText(r) : "inaktiv"));
      main.append(meter);
      row.append(main);
      if (ctx.isAdmin()) {
        const actions = el("div", "rule-actions");
        const toggle = el("button", "btn sm", r.aktiv ? "Deaktivieren" : "Aktivieren");
        toggle.type = "button";
        toggle.addEventListener("click", () => save({ ...r, aktiv: !r.aktiv }, r.id));
        const edit = el("button", "btn sm", "Bearbeiten");
        edit.type = "button";
        edit.addEventListener("click", () => startEdit(r));
        const del = el("button", "btn sm danger", "Löschen");
        del.type = "button";
        del.addEventListener("click", () => remove(r));
        actions.append(toggle, edit, del);
        row.append(actions);
      }
      box.append(row);
    }
  }

  function fillTypes() {
    const select = $("#rule-form").elements.type_id;
    const current = select.value;
    select.replaceChildren(...data.types.map((t) => new Option(t.code ? `${t.code} · ${t.name}` : t.name, String(t.id))));
    if (current) select.value = current;
  }

  function startEdit(r) {
    editing = r;
    const f = $("#rule-form").elements;
    f.von.value = r.von;
    f.bis.value = r.bis;
    f.operator.value = r.operator;
    f.stunden.value = r.stunden;
    f.type_id.value = String(r.type_id);
    $("#rule-form-title").textContent = "Regel bearbeiten";
    $("#rule-submit").textContent = "Speichern";
    $("#rule-cancel").hidden = false;
    $("#rule-form-card").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetForm() {
    editing = null;
    const form = $("#rule-form");
    form.querySelector(".form-error").textContent = "";
    form.elements.stunden.value = "";
    $("#rule-form-title").textContent = "Neue Regel";
    $("#rule-submit").textContent = "Regel anlegen";
    $("#rule-cancel").hidden = true;
  }

  async function save(rule, id) {
    try {
      await ctx.api(id ? `/rules/${id}` : "/rules", { method: id ? "PUT" : "POST", body: rule });
      await load();
      return true;
    } catch (err) {
      ctx.toast(err.message);
      return false;
    }
  }

  async function remove(r) {
    try {
      await ctx.api(`/rules/${r.id}`, { method: "DELETE" });
      ctx.toast("Regel gelöscht", {
        label: "Rückgängig",
        run: () => save({ type_id: r.type_id, von: r.von, bis: r.bis, operator: r.operator, stunden: r.stunden, aktiv: r.aktiv, notiz: r.notiz }),
      });
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
    $("#rule-form-card").hidden = !ctx.isAdmin();
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
      const f = form.elements;
      const rule = {
        von: f.von.value,
        bis: f.bis.value,
        operator: f.operator.value,
        stunden: f.stunden.value === "" ? null : Number(f.stunden.value),
        type_id: Number(f.type_id.value),
        aktiv: editing ? editing.aktiv : true,
        notiz: editing?.notiz || "",
      };
      try {
        await ctx.api(editing ? `/rules/${editing.id}` : "/rules", { method: editing ? "PUT" : "POST", body: rule });
        ctx.toast(editing ? "Regel gespeichert" : "Regel angelegt");
        resetForm();
        await load();
      } catch (err) {
        form.querySelector(".form-error").textContent = err.message;
      }
    });
    $("#rule-cancel").addEventListener("click", resetForm);
  }

  window.RulesPage = { init, setData, show };
})();
