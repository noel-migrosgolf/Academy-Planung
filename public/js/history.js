// Verlauf des aktuellen Plans: gespeicherte Stände der Events (Zuweisungen), mit «Wiederherstellen»
// (nur mit Bearbeitungsrecht am Plan).
(function () {
  const { el } = window.Dates;
  const $ = (sel) => document.querySelector(sel);

  let ctx = null; // { api, toast, reload, canEdit }

  function formatTime(iso) {
    return new Date(iso).toLocaleString("de-CH", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  async function restore(version, latestId) {
    try {
      await ctx.api(`/versions/${version.id}/restore`, { method: "POST" });
      ctx.toast(`Version #${version.id} wiederhergestellt`, {
        label: "Rückgängig",
        run: async () => {
          try {
            await ctx.api(`/versions/${latestId}/restore`, { method: "POST" });
            ctx.toast("Wiederherstellung rückgängig gemacht");
            ctx.reload();
            load();
          } catch (err) {
            ctx.toast(err.message);
          }
        },
      });
      ctx.reload();
      load();
    } catch (err) {
      ctx.toast(err.message);
    }
  }

  async function load() {
    let versions;
    try {
      ({ versions } = await ctx.api("/versions"));
    } catch (err) {
      ctx.toast(err.message);
      return;
    }
    const tbody = $("#version-list");
    tbody.replaceChildren();
    const latestId = versions[0]?.id;
    for (const v of versions) {
      const tr = el("tr");
      const action = el("td");
      if (v.id === latestId) {
        action.append(el("span", "badge", "aktuell"));
      } else if (ctx.canEdit()) {
        const btn = el("button", "btn sm", "Wiederherstellen");
        btn.type = "button";
        btn.title = "Die Events (Zuweisungen) auf diesen Stand zurücksetzen; Pros und Event-Typen bleiben";
        btn.addEventListener("click", () => restore(v, latestId));
        action.append(btn);
      }
      tr.append(
        el("td", "tab muted", `#${v.id}`),
        el("td", "tab", formatTime(v.created_at)),
        el("td", "", v.actor),
        el("td", "", v.description),
        el("td", "tab muted", `${v.events} Events`),
        action
      );
      tbody.append(tr);
    }
    $("#version-count").textContent = `${versions.length} ${versions.length === 1 ? "Version" : "Versionen"}`;
  }

  function init(context) {
    ctx = context;
  }

  window.HistoryPage = { init, load };
})();
