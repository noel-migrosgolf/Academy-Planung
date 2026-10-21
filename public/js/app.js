(function () {
  const YEAR = 2027;
  const $ = (sel) => document.querySelector(sel);

  const views = { login: $("#view-login"), calendar: $("#view-calendar") };
  const btnAdmin = $("#btn-admin");
  const btnUsers = $("#btn-users");
  const btnLogout = $("#btn-logout");
  const sessionInfo = $("#session-info");
  const dlgAdminLogin = $("#dlg-admin-login");
  const dlgUsers = $("#dlg-users");

  let session = null;

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

  function render() {
    views.login.hidden = !!session;
    views.calendar.hidden = !session;
    btnLogout.hidden = !session;
    sessionInfo.hidden = !session;
    btnUsers.hidden = session?.role !== "admin";
    btnAdmin.hidden = !!session;

    if (session) {
      sessionInfo.textContent = session.name;
      $("#cal-year").textContent = YEAR;
      Calendar.render($("#calendar"), $("#legend"), YEAR, window.FERIEN_ZUG);
    }
  }

  async function renderUsers() {
    const { users } = await api("/users");
    const tbody = $("#user-list");
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
      del.className = "btn btn-danger btn-sm";
      del.textContent = "Löschen";
      del.addEventListener("click", async () => {
        if (confirm(`Benutzer «${user.username}» wirklich löschen?`)) {
          await api(`/users/${user.id}`, { method: "DELETE" });
          renderUsers();
        }
      });
      actions.appendChild(del);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    }
    $("#user-empty").hidden = users.length > 0;
    $(".user-table").hidden = users.length === 0;
  }

  async function openUsers() {
    showError($("#user-form"));
    dlgUsers.showModal();
    try {
      await renderUsers();
    } catch (err) {
      showError($("#user-form"), err.message);
    }
  }

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
      render();
      openUsers();
    } catch (err) {
      showError(form, err.message);
    }
  });

  btnUsers.addEventListener("click", openUsers);

  $("#user-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await api("/users", {
        method: "POST",
        body: {
          name: form.elements.name.value,
          username: form.username.value,
          password: form.password.value,
        },
      });
      form.reset();
      showError(form);
      renderUsers();
    } catch (err) {
      showError(form, err.message);
    }
  });

  btnLogout.addEventListener("click", async () => {
    await api("/logout", { method: "POST" }).catch(() => {});
    session = null;
    render();
  });

  document.querySelectorAll("[data-close]").forEach((btn) =>
    btn.addEventListener("click", () => btn.closest("dialog").close())
  );

  api("/me")
    .then((data) => (session = data.user))
    .catch(() => (session = null))
    .finally(render);
})();
