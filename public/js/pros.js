// Pros-Seite: Übersicht der Einstellungen und Bearbeiten-Dialog (Admin).
(function () {
  const { el } = window.Dates;
  const $ = (sel) => document.querySelector(sel);

  const WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
  const RULES = { wochenend_wechsel_AB: "Wochenend-Wechsel A/B" };

  let ctx = null; // { api, toast, reload }
  let editing = null; // Pro im Dialog, null = neuer Pro

  function formatDate(iso) {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function absenceText(a) {
    const range = a.von === a.bis ? formatDate(a.von) : `${formatDate(a.von)} – ${formatDate(a.bis)}`;
    return a.grund ? `${range} · ${a.grund}` : range;
  }

  function tag(label, on) {
    return el("span", on ? "tag" : "tag no", label);
  }

  function row(label, value) {
    const r = el("div", "pro-row");
    r.append(el("span", "k", label), el("span", "v", value));
    return r;
  }

  function card(pro, isAdmin) {
    const c = el("div", "card pro");

    const head = el("div", "pro-head");
    const title = el("div");
    title.append(el("div", "nm", pro.name));
    title.append(el("div", "meta", `${pro.code || "–"} · ${Number(pro.lektionen_jahr).toLocaleString("de-CH")} Lektionen/Jahr`));
    head.append(title);
    if (isAdmin) {
      const edit = el("button", "btn sm", "Bearbeiten");
      edit.type = "button";
      edit.addEventListener("click", () => openDialog(pro));
      head.append(edit);
    }
    c.append(head);

    const tags = el("div", "tags");
    tags.append(tag("Kurse", pro.kurse), tag("Bambini", pro.bambinitraining), tag("GCE", pro.gce_training));
    c.append(tags);

    const rows = el("div", "pro-rows");
    rows.append(row("Freie Tage", pro.freie_tage.length ? pro.freie_tage.join(", ") : "keine"));
    if (pro.verfuegbarkeitsregel) rows.append(row("Regel", RULES[pro.verfuegbarkeitsregel] || pro.verfuegbarkeitsregel));
    rows.append(row("Soll-Auslastung", `${pro.auslastung_soll_prozent} %`));
    rows.append(row("Abwesenheiten", pro.abwesenheiten.length ? pro.abwesenheiten.map(absenceText).join("\n") : "keine"));
    c.append(rows);
    return c;
  }

  function render(pros, isAdmin) {
    const list = $("#pro-list");
    list.replaceChildren(...pros.map((p) => card(p, isAdmin)));
    if (!pros.length) list.append(el("p", "empty", "Noch keine Pros erfasst."));
  }

  // --- Dialog ---

  function absenceRow(a = { von: "", bis: "", grund: "" }) {
    const r = el("div", "absence");
    const von = el("input");
    von.type = "date";
    von.value = a.von;
    von.setAttribute("aria-label", "von");
    const bis = el("input");
    bis.type = "date";
    bis.value = a.bis;
    bis.setAttribute("aria-label", "bis");
    const grund = el("input");
    grund.type = "text";
    grund.placeholder = "Grund (optional)";
    grund.value = a.grund;
    const del = el("button", "btn sm icon ghost", "×");
    del.type = "button";
    del.setAttribute("aria-label", "Abwesenheit entfernen");
    del.addEventListener("click", () => r.remove());
    r.append(von, bis, grund, del);
    return r;
  }

  function openDialog(pro) {
    editing = pro;
    const form = $("#pro-edit-form");
    form.reset();
    form.querySelector(".form-error").textContent = "";
    $("#pro-edit-title").textContent = pro ? `${pro.name} bearbeiten` : "Neuer Pro";
    $("#pro-delete").hidden = !pro;

    const p = pro || { name: "", code: "", lektionen_jahr: 0, auslastung_soll_prozent: 100, kurse: true, bambinitraining: false, gce_training: false, freie_tage: [], verfuegbarkeitsregel: null, abwesenheiten: [] };
    const f = form.elements;
    f.name.value = p.name;
    f.code.value = p.code || "";
    f.lektionen_jahr.value = p.lektionen_jahr;
    f.auslastung_soll_prozent.value = p.auslastung_soll_prozent;
    f.kurse.checked = p.kurse;
    f.bambinitraining.checked = p.bambinitraining;
    f.gce_training.checked = p.gce_training;
    f.verfuegbarkeitsregel.value = p.verfuegbarkeitsregel || "";
    $$days().forEach((cb) => (cb.checked = p.freie_tage.includes(cb.value)));
    $("#pro-absences").replaceChildren(...p.abwesenheiten.map(absenceRow));

    $("#dlg-pro").showModal();
  }

  function $$days() {
    return document.querySelectorAll("#pro-days input");
  }

  function readForm() {
    const f = $("#pro-edit-form").elements;
    return {
      name: f.name.value,
      code: f.code.value,
      lektionen_jahr: Number(f.lektionen_jahr.value),
      auslastung_soll_prozent: Number(f.auslastung_soll_prozent.value),
      kurse: f.kurse.checked,
      bambinitraining: f.bambinitraining.checked,
      gce_training: f.gce_training.checked,
      freie_tage: [...$$days()].filter((cb) => cb.checked).map((cb) => cb.value),
      verfuegbarkeitsregel: f.verfuegbarkeitsregel.value || null,
      abwesenheiten: [...document.querySelectorAll("#pro-absences .absence")]
        .map((r) => {
          const [von, bis, grund] = r.querySelectorAll("input");
          return { von: von.value, bis: bis.value || von.value, grund: grund.value };
        })
        .filter((a) => a.von || a.grund),
    };
  }

  function init(context) {
    ctx = context;

    $("#pro-days").replaceChildren(
      ...WEEKDAYS.map((day) => {
        const label = el("label", "check day");
        const cb = el("input");
        cb.type = "checkbox";
        cb.value = day;
        label.append(cb, document.createTextNode(day.slice(0, 2)));
        label.title = day;
        return label;
      })
    );

    $("#btn-new-pro").addEventListener("click", () => openDialog(null));
    $("#pro-absence-add").addEventListener("click", () => $("#pro-absences").append(absenceRow()));

    $("#pro-edit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      try {
        const { pro } = await ctx.api(editing ? `/pros/${editing.id}` : "/pros", {
          method: editing ? "PUT" : "POST",
          body: readForm(),
        });
        $("#dlg-pro").close();
        ctx.toast(editing ? `«${pro.name}» gespeichert` : `Pro «${pro.name}» angelegt`);
        ctx.reload();
      } catch (err) {
        form.querySelector(".form-error").textContent = err.message;
      }
    });

    $("#pro-delete").addEventListener("click", async () => {
      if (!editing || !confirm(`Pro «${editing.name}» wirklich löschen?`)) return;
      try {
        await ctx.api(`/pros/${editing.id}`, { method: "DELETE" });
        $("#dlg-pro").close();
        ctx.toast(`Pro «${editing.name}» gelöscht`);
        ctx.reload();
      } catch (err) {
        $("#pro-edit-form .form-error").textContent = err.message;
      }
    });
  }

  window.ProsPage = { init, render };
})();
