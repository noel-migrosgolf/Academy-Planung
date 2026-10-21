(function () {
  const YEAR = 2027;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const app = $("#app");
  const side = $(".side");
  const btnAdmin = $("#btn-admin");
  const btnLogout = $("#btn-logout");
  const dlgAdminLogin = $("#dlg-admin-login");
  const pages = {
    calendar: $("#page-calendar"),
    events: $("#page-events"),
    planned: $("#page-planned"),
    pros: $("#page-pros"),
    ferien: $("#page-ferien"),
    users: $("#page-users"),
  };

  let session = null;
  let currentPage = "calendar";
  let pros = [];

  Planner.init(pages.calendar);
  ProsPage.init({
    api,
    toast,
    reload: () => loadData(),
  });
  Events.init({
    api,
    toast,
    reload: () => loadData(),
    isAdmin: () => session?.role === "admin",
  });

  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Unbekannter Fehler.");
    return data;
  }

  function showError(form, message) {
    form.querySelector(".form-error").textContent = message || "";
  }

  let toastTimer;
  // Kurze Meldung unten; optional mit Aktion, z. B. { label: "Rückgängig", run }
  function toast(message, action) {
    const el = $("#toast");
    el.replaceChildren(document.createTextNode(message));
    if (action) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        el.classList.remove("on");
        action.run();
      });
      el.appendChild(btn);
    }
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), action ? 6000 : 2400);
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");
  }

  function firstName(name) {
    return name.trim().split(/\s+/)[0];
  }

  // Theme (hell/dunkel)
  $$("[data-theme-toggle]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const root = document.documentElement;
      const dark = root.dataset.theme
        ? root.dataset.theme === "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches;
      root.dataset.theme = dark ? "light" : "dark";
      try {
        localStorage.setItem("academy.theme", root.dataset.theme);
      } catch {}
    })
  );

  function showPage(name) {
    if (name === "users" && session?.role !== "admin") name = "calendar";
    currentPage = name;
    for (const [key, el] of Object.entries(pages)) el.hidden = key !== name;
    $$(".nav button[data-page]").forEach((b) => b.classList.toggle("on", b.dataset.page === name));
    if (name === "calendar") Planner.render();
    if (name === "events" || name === "planned") Events.render();
    if (name === "pros") renderPros();
    if (name === "ferien") {
      $("#cal-year").textContent = YEAR;
      HolidayCalendar.render($("#calendar"), $("#legend"), YEAR, window.FERIEN_ZUG);
    }
    if (name === "users") loadUsers();
  }

  function render() {
    const loggedIn = !!session;
    app.classList.toggle("guest", !loggedIn);
    side.hidden = !loggedIn;
    $("#view-login").hidden = loggedIn;
    $("#session-info").hidden = !loggedIn;
    btnLogout.hidden = !loggedIn;
    $$("[data-admin]").forEach((el) => (el.hidden = session?.role !== "admin"));

    if (loggedIn) {
      $("#session-name").textContent = session.name;
      $("#session-avatar").textContent = initials(session.name);
      showPage(currentPage);
      loadData();
    } else {
      for (const el of Object.values(pages)) el.hidden = true;
      renderUserPicker();
      lstep("user");
    }
  }

  // Lädt Pros, Event-Typen und Events und verteilt sie an alle Ansichten.
  async function loadData() {
    let types;
    let events;
    try {
      [{ pros }, { types }, { events }] = await Promise.all([
        api("/pros"),
        api("/event-types"),
        api(`/events?from=${YEAR}-01-01&to=${YEAR}-12-31`),
      ]);
    } catch (err) {
      toast(err.message);
      return;
    }
    const data = { pros, types, events };
    Events.setData(data);
    Planner.setData(data);
    if (currentPage === "pros") renderPros();
  }

  function renderPros() {
    ProsPage.render(pros, session?.role === "admin");
  }

  async function loadUsers() {
    const tbody = $("#user-list");
    let users;
    try {
      ({ users } = await api("/users"));
    } catch (err) {
      toast(err.message);
      return;
    }
    tbody.replaceChildren();
    for (const user of users) {
      const tr = document.createElement("tr");
      const created = new Date(user.created_at).toLocaleDateString("de-CH");
      for (const value of [user.name, user.username, created]) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      }

      // Admin-Rechte direkt in der Tabelle umschalten
      const adminCell = document.createElement("td");
      const adminLabel = document.createElement("label");
      adminLabel.className = "check sm";
      const adminBox = document.createElement("input");
      adminBox.type = "checkbox";
      adminBox.checked = user.is_admin;
      adminLabel.append(adminBox, document.createTextNode("Admin"));
      adminBox.addEventListener("change", async () => {
        const self = user.id === session?.id;
        try {
          await api(`/users/${user.id}`, { method: "PATCH", body: { is_admin: adminBox.checked } });
          toast(`${user.name}: Admin-Rechte ${adminBox.checked ? "erteilt" : "entzogen"}`);
          if (self) {
            ({ user: session } = await api("/me"));
            render();
          }
        } catch (err) {
          adminBox.checked = !adminBox.checked;
          toast(err.message);
        }
      });
      adminCell.appendChild(adminLabel);
      tr.appendChild(adminCell);

      const actions = document.createElement("td");
      const del = document.createElement("button");
      del.className = "btn sm danger";
      del.textContent = "Löschen";
      del.addEventListener("click", async () => {
        try {
          await api(`/users/${user.id}`, { method: "DELETE" });
          toast(`Benutzer «${user.username}» gelöscht`);
          if (user.id === session?.id) {
            // Eigenes Konto gelöscht: Anmeldung ist damit beendet.
            session = null;
            render();
            return;
          }
          loadUsers();
        } catch (err) {
          toast(err.message);
        }
      });
      actions.appendChild(del);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
    $("#user-count").textContent = `${users.length} ${users.length === 1 ? "Eintrag" : "Einträge"}`;
    $("#user-empty").hidden = users.length > 0;
    $("#page-users table").hidden = users.length === 0;
  }

  // Navigation
  $$(".nav button[data-page]").forEach((btn) =>
    btn.addEventListener("click", () => showPage(btn.dataset.page))
  );

  // Login (Ablauf wie im Event Manager: Benutzer → Passwort → Laden → Begrüssung)
  const GREETINGS = {
    morgen: [
      "Guten Morgen, {u}! Bereit für den Tag?",
      "Morgen, {u}! Der Kaffee ist gemacht – was steht an?",
      "Schön, dass du da bist, {u}. Womit starten wir?",
    ],
    tag: [
      "Willkommen zurück, {u}. Was steht heute an?",
      "Hallo {u}! Womit möchtest du weitermachen?",
      "Da bist du ja, {u}. Auf zur nächsten Planung!",
      "Schön dich zu sehen, {u}. Was ist heute dran?",
      "Alles bereit, {u}. Womit fangen wir an?",
    ],
    abend: [
      "Guten Abend, {u}. Noch etwas Wichtiges offen?",
      "Späte Schicht, {u}? Was steht noch an?",
      "Hallo {u}! Lass uns den Tag abschliessen.",
    ],
    freitag: [
      "Freitag, {u}! Was planen wir noch vor dem Wochenende?",
      "Endspurt, {u}. Was steht noch an?",
    ],
    montag: [
      "Neue Woche, {u}! Womit starten wir?",
      "Montag, {u}. Auf ein Neues – was liegt an?",
    ],
  };

  function pickGreeting(name) {
    const d = new Date();
    const h = d.getHours();
    const wd = d.getDay();
    const pool = GREETINGS.tag.slice();
    if (h < 11) pool.push(...GREETINGS.morgen);
    else if (h >= 18) pool.push(...GREETINGS.abend);
    if (wd === 1) pool.push(...GREETINGS.montag);
    if (wd === 5) pool.push(...GREETINGS.freitag);
    return pool[Math.floor(Math.random() * pool.length)].replace(/\{u\}/g, name);
  }

  let loginUsers = [];
  let pending = null;

  function lstep(name) {
    $$(".lstep").forEach((s) => s.classList.toggle("on", s.dataset.step === name));
    // Logo und Schriftzug nur bei der Benutzerwahl zeigen
    $(".login .brandmark").hidden = name !== "user";
  }

  async function renderUserPicker() {
    const box = $("#users");
    box.innerHTML = '<div class="note">Benutzer werden geladen …</div>';
    try {
      ({ users: loginUsers } = await api("/auth/users"));
    } catch (err) {
      box.innerHTML = '<div class="note err">Server nicht erreichbar.</div>';
      return;
    }
    box.replaceChildren();
    if (!loginUsers.length) {
      box.innerHTML = '<div class="note">Noch keine Benutzer angelegt. Bitte oben rechts im Admin-Bereich anlegen.</div>';
      return;
    }
    for (const user of loginUsers) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "user-pick";
      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = initials(user.name);
      const name = document.createElement("span");
      name.className = "user-name";
      name.textContent = user.name;
      btn.append(avatar, name);
      btn.addEventListener("click", () => openPwStep(user));
      box.appendChild(btn);
    }
  }

  function openPwStep(user) {
    pending = user;
    $("#pw-avatar").textContent = initials(user.name);
    $("#pw-name").textContent = user.name;
    $("#pw-input").value = "";
    $("#pw-input").type = "password";
    $("#pw-err").textContent = "";
    lstep("pw");
    setTimeout(() => $("#pw-input").focus(), 60);
  }

  async function tryLogin() {
    const input = $("#pw-input");
    if (!input.value) {
      $("#pw-err").textContent = "Bitte Passwort eingeben.";
      return;
    }
    const btn = $("#pw-go");
    btn.disabled = true;
    btn.textContent = "Prüfe …";
    try {
      const { user } = await api("/login", {
        method: "POST",
        body: { userId: pending.id, password: input.value },
      });
      $("#pw-err").textContent = "";
      startLoading(user);
    } catch (err) {
      $("#pw-err").textContent = err.message || "Anmeldung fehlgeschlagen.";
      input.classList.add("err");
      setTimeout(() => input.classList.remove("err"), 350);
      input.select();
    } finally {
      btn.disabled = false;
      btn.textContent = "Anmelden";
    }
  }

  function startLoading(user) {
    $("#load-avatar").textContent = initials(user.name);
    $("#load-name").textContent = `${user.name} wird angemeldet`;
    lstep("load");
    const steps = $$("#load-steps li");
    steps.forEach((s) => s.classList.remove("on"));
    [250, 1150, 2050].forEach((delay, i) => setTimeout(() => steps[i].classList.add("on"), delay));
    setTimeout(() => showWelcome(user), 2750);
  }

  function showWelcome(user) {
    $("#wel-avatar").textContent = initials(user.name);
    lstep("welcome");
    const text = pickGreeting(firstName(user.name));
    const el = $("#wel-txt");
    el.textContent = "";
    let i = 0;
    const tick = () => {
      if (i <= text.length) {
        el.textContent = text.slice(0, i++);
        setTimeout(tick, 28 + Math.random() * 34);
      } else {
        setTimeout(() => finishLogin(user), 2000);
      }
    };
    setTimeout(tick, 260);
  }

  function finishLogin(user) {
    session = user;
    pending = null;
    currentPage = "calendar";
    render();
    toast(`Willkommen, ${firstName(user.name)}!`);
  }

  $("#pw-go").addEventListener("click", tryLogin);
  $("#pw-back").addEventListener("click", () => {
    pending = null;
    lstep("user");
  });
  $("#pw-eye").addEventListener("click", () => {
    const input = $("#pw-input");
    input.type = input.type === "password" ? "text" : "password";
    $("#pw-eye").setAttribute("aria-label", input.type === "password" ? "Passwort anzeigen" : "Passwort verbergen");
    input.focus();
  });
  $("#pw-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      tryLogin();
    }
    if (e.key === "Escape") $("#pw-back").click();
  });

  // Admin
  btnAdmin.addEventListener("click", () => {
    const form = $("#admin-login-form");
    form.reset();
    showError(form);
    dlgAdminLogin.showModal();
  });

  $("#admin-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      ({ user: session } = await api("/admin/login", {
        method: "POST",
        body: { password: form.password.value },
      }));
      dlgAdminLogin.close();
      currentPage = "users";
      render();
    } catch (err) {
      showError(form, err.message);
    }
  });

  $("#user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      const { user } = await api("/users", {
        method: "POST",
        body: {
          name: form.elements.name.value,
          username: form.username.value,
          password: form.password.value,
          is_admin: form.elements.is_admin.checked,
        },
      });
      form.reset();
      showError(form);
      toast(`Benutzer «${user.username}» angelegt`);
      loadUsers();
    } catch (err) {
      showError(form, err.message);
    }
  });

  btnLogout.addEventListener("click", async () => {
    await api("/logout", { method: "POST" }).catch(() => {});
    session = null;
    currentPage = "calendar";
    render();
  });

  $$("[data-close]").forEach((btn) =>
    btn.addEventListener("click", () => btn.closest("dialog").close())
  );

  api("/me")
    .then((data) => (session = data.user))
    .catch(() => (session = null))
    .finally(render);
})();
