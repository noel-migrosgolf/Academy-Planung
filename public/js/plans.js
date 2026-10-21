// Pläne: Auswahl oben, Dialog zum Anlegen (auch als Kopie), Umbenennen, Löschen und Teilen.
// Der aktuelle Plan geht mit jeder API-Anfrage als Header «X-Plan-Id» mit (siehe app.js) und
// wird pro Benutzer im Browser gemerkt.
(function () {
  const { el } = window.Dates;
  const $ = (sel) => document.querySelector(sel);

  let ctx = null; // { api, toast, session, onChange }
  let plans = [];
  let current = null;
  let users = null; // für das Teilen, einmal geladen
  let openShare = null; // Plan-ID mit offenem Teilen-Bereich

  const storageKey = () => `academy.plan.${ctx.session()?.id ?? ctx.session()?.role ?? "?"}`;

  function remember(id) {
    try {
      localStorage.setItem(storageKey(), String(id));
    } catch {}
  }

  function remembered() {
    try {
      return Number(localStorage.getItem(storageKey()));
    } catch {
      return null;
    }
  }

  // Lädt die Pläne und wählt den gemerkten (sonst den ersten).
  // Jeder Benutzer hat einen eigenen Plan: fehlt er, wird «Mein Plan» angelegt.
  async function load() {
    ({ plans } = await ctx.api("/plans", { plan: false }));
    if (ctx.session()?.id && !plans.some((p) => p.is_owner)) {
      await ctx.api("/plans", { method: "POST", body: { name: "Mein Plan" }, plan: false });
      ({ plans } = await ctx.api("/plans", { plan: false }));
    }
    const wanted = current?.id ?? remembered();
    current = plans.find((p) => p.id === wanted) || plans[0] || null;
    if (current) remember(current.id);
    renderBar();
    if ($("#dlg-plans").open) renderList();
  }

  function renderBar() {
    const select = $("#plan-select");
    select.replaceChildren(...plans.map((p) => new Option(p.is_owner ? p.name : `${p.name} (${p.owner})`, String(p.id))));
    if (current) select.value = String(current.id);
    $("#plan-bar").hidden = !current;
    $("#plan-ro").hidden = !current || current.can_edit;
    document.body.classList.toggle("plan-readonly", !!current && !current.can_edit);
  }

  async function switchTo(id) {
    const next = plans.find((p) => p.id === id);
    if (!next || next.id === current?.id) return;
    current = next;
    remember(id);
    renderBar();
    renderList();
    await ctx.onChange();
    ctx.toast(`Plan «${next.name}» geöffnet`);
  }

  // --- Dialog ---

  function renderList() {
    const box = $("#plan-list");
    box.replaceChildren();
    for (const p of plans) {
      const row = el("div", `plan-row${p.id === current?.id ? " on" : ""}`);
      const main = el("div", "plan-main");
      const name = el("div", "plan-name", p.name);
      main.append(name, el("div", "plan-meta", `${p.owner} · ${p.events} Termine · ${p.role}${p.id === current?.id ? " · geöffnet" : ""}`));
      row.append(main);
      const actions = el("div", "plan-btns");
      const button = (label, cls, run) => {
        const b = el("button", `btn sm${cls}`, label);
        b.type = "button";
        b.addEventListener("click", () => run(b));
        actions.append(b);
        return b;
      };
      if (p.id !== current?.id) button("Öffnen", "", () => switchTo(p.id));
      if (p.can_manage) {
        button("Umbenennen", "", () => rename(p, name));
        button("Teilen", openShare === p.id ? " on" : "", () => {
          openShare = openShare === p.id ? null : p.id;
          renderList();
        });
        button("Löschen", " danger", (b) => remove(p, b));
      }
      row.append(actions);
      box.append(row);
      if (openShare === p.id) box.append(sharePanel(p));
    }
  }

  // Name direkt in der Zeile bearbeiten (Enter speichert, Esc bricht ab)
  function rename(p, nameEl) {
    const input = el("input");
    input.value = p.name;
    input.maxLength = 80;
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    input.addEventListener("keydown", async (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        renderList();
      }
      if (e.key !== "Enter") return;
      e.preventDefault();
      try {
        await ctx.api(`/plans/${p.id}`, { method: "PUT", body: { name: input.value }, plan: false });
        await load();
      } catch (err) {
        $("#plan-error").textContent = err.message;
      }
    });
    input.addEventListener("blur", () => setTimeout(renderList, 150));
  }

  // Löschen in zwei Schritten (ohne Browser-Dialog): erster Klick fragt nach, zweiter löscht.
  async function remove(p, button) {
    if (!button.dataset.confirm) {
      button.dataset.confirm = "1";
      button.textContent = "Wirklich löschen?";
      setTimeout(() => {
        if (button.isConnected) {
          delete button.dataset.confirm;
          button.textContent = "Löschen";
        }
      }, 4000);
      return;
    }
    try {
      await ctx.api(`/plans/${p.id}`, { method: "DELETE", plan: false });
      const wasCurrent = p.id === current?.id;
      if (wasCurrent) current = null;
      await load();
      ctx.toast(`Plan «${p.name}» gelöscht`);
      if (wasCurrent) await ctx.onChange();
    } catch (err) {
      $("#plan-error").textContent = err.message;
    }
  }

  function sharePanel(p) {
    const panel = el("div", "plan-share");
    panel.append(el("div", "plan-share-hd", "Mit wem teilen?"));
    const list = el("div", "plan-share-list", "Lade …");
    panel.append(list);
    (async () => {
      try {
        users ??= (await ctx.api("/auth/users", { plan: false })).users;
        const { shares } = await ctx.api(`/plans/${p.id}/shares`, { plan: false });
        const access = new Map(shares.map((s) => [s.id, s.can_edit ? "bearbeiten" : "ansehen"]));
        list.replaceChildren();
        const me = ctx.session()?.id;
        const others = users.filter((u) => u.id !== me && u.name !== p.owner);
        if (!others.length) list.append(el("span", "muted", "Es gibt noch keine anderen Benutzer."));
        for (const u of others) {
          const row = el("label", "plan-share-row");
          const select = el("select", "fsel");
          for (const [value, label] of [["keiner", "kein Zugriff"], ["ansehen", "darf ansehen"], ["bearbeiten", "darf bearbeiten"]]) {
            select.append(new Option(label, value));
          }
          select.value = access.get(u.id) || "keiner";
          select.addEventListener("change", async () => {
            try {
              await ctx.api(`/plans/${p.id}/shares`, { method: "PUT", body: { user_id: u.id, access: select.value }, plan: false });
              ctx.toast(select.value === "keiner" ? `Zugriff für ${u.name} entfernt` : `Plan mit ${u.name} geteilt (${select.value})`);
            } catch (err) {
              ctx.toast(err.message);
            }
          });
          row.append(el("span", "", u.name), select);
          list.append(row);
        }
      } catch (err) {
        list.textContent = err.message;
      }
    })();
    return panel;
  }

  function openDialog() {
    $("#plan-error").textContent = "";
    $("#plan-new").reset();
    openShare = null;
    renderList();
    $("#dlg-plans").showModal();
  }

  function init(context) {
    ctx = context;
    $("#plan-select").addEventListener("change", (e) => switchTo(Number(e.target.value)));
    $("#btn-plans").addEventListener("click", openDialog);
    $("#plan-new").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      $("#plan-error").textContent = "";
      try {
        const { plan } = await ctx.api("/plans", {
          method: "POST",
          body: { name: f.name.value, copy_from: f.copy.checked ? current?.id : undefined },
          plan: false,
        });
        e.target.reset();
        await load();
        $("#dlg-plans").close();
        await switchTo(plan.id);
      } catch (err) {
        $("#plan-error").textContent = err.message;
      }
    });
  }

  window.PlansUI = {
    init,
    load,
    currentId: () => current?.id ?? null,
    canEdit: () => !!current?.can_edit,
    reset: () => {
      plans = [];
      current = null;
      users = null;
      $("#plan-bar").hidden = true;
      document.body.classList.remove("plan-readonly");
    },
  };
})();
