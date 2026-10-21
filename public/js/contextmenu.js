// Kontextmenü für Rechtsklick: ContextMenu.open(event, [{ label, hint, danger, action }, …]).
(function () {
  let menu = null;

  function close() {
    if (!menu) return;
    menu.remove();
    menu = null;
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("blur", close);
    document.removeEventListener("scroll", close, true);
  }

  function onOutside(e) {
    if (menu && !menu.contains(e.target)) close();
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const buttons = [...menu.querySelectorAll("button")];
      const i = buttons.indexOf(document.activeElement);
      const next = e.key === "ArrowDown" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  }

  function open(e, items) {
    e.preventDefault();
    e.stopPropagation();
    close();

    menu = document.createElement("div");
    menu.className = "ctx";
    menu.setAttribute("role", "menu");
    for (const item of items) {
      if (item === "-") {
        menu.appendChild(Object.assign(document.createElement("div"), { className: "ctx-sep" }));
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "menuitem");
      if (item.danger) btn.classList.add("danger");
      btn.textContent = item.label;
      if (item.hint) {
        const hint = document.createElement("small");
        hint.textContent = item.hint;
        btn.appendChild(hint);
      }
      btn.addEventListener("click", () => {
        close();
        item.action();
      });
      menu.appendChild(btn);
    }
    document.body.appendChild(menu);

    // Im sichtbaren Bereich halten
    const { innerWidth: w, innerHeight: h } = window;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(e.clientX, w - rect.width - 8)}px`;
    menu.style.top = `${Math.min(e.clientY, h - rect.height - 8)}px`;
    menu.querySelector("button")?.focus();

    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    document.addEventListener("scroll", close, true);
  }

  window.ContextMenu = { open, close };
})();
