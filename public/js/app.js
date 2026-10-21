(function () {
  const YEAR = 2027;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const app = $("#app");
  const side = $(".side");
  const btnAdmin = $("#btn-admin");
  const btnLogout = $("#btn-logout");
  const dlgAdminLogin = $("#dlg-admin-login");
  const pages = { calendar: $("#page-calendar"), users: $("#page-users") };

  let session = null;
  let currentPage = "calendar";

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
  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("on"), 2400);
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");
  }

  // Theme (hell/dunkel)
  $("#btn-theme").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem("academy.theme", root.dataset.theme);
    } catch {}
  });

  function showPage(name) {
    if (name === "users" && session?.role !== "admin") name = "calendar";
    currentPage = name;
    for (const [key, el] of Object.entries(pages)) el.hidden = key !== name;
    $$(".nav button[data-page]").forEach((b) => b.classList.toggle("on", b.dataset.page === name));
    if (name === "calendar") {
      $("#cal-year").textContent = YEAR;
      Calendar.render($("#calendar"), $("#legend"), YEAR, window.FERIEN_ZUG);
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
    btnAdmin.hidden = loggedIn;
    $$("[data-admin]").forEach((el) => (el.hidden = session?.role !== "admin"));

    if (loggedIn) {
      $("#session-name").textContent = session.name;
      $("#session-avatar").textContent = initials(session.name);
      showPage(currentPage);
    } else {
      for (const el of Object.values(pages)) el.hidden = true;
    }
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
      const actions = document.createElement("td");
      const del = document.createElement("button");
      del.className = "btn sm danger";
      del.textContent = "Löschen";
      del.addEventListener("click", async () => {
        if (!confirm(`Benutzer «${user.username}» wirklich löschen?`)) return;
        try {
          await api(`/users/${user.id}`, { method: "DELETE" });
          toast(`Benutzer «${user.username}» gelöscht`);
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

  // Login
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      ({ user: session } = await api("/login", {
        method: "POST",
        body: { username: form.username.value, password: form.password.value },
      }));
      form.reset();
      showError(form);
      currentPage = "calendar";
      render();
    } catch (err) {
      showError(form, err.message);
    }
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
