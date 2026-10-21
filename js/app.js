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

  function showError(form, message) {
    form.querySelector(".form-error").textContent = message || "";
  }

  function render() {
    const session = Auth.getSession();
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

  function renderUsers() {
    const users = Auth.getUsers();
    const tbody = $("#user-list");
    tbody.replaceChildren();
    for (const user of users) {
      const tr = document.createElement("tr");
      const created = new Date(user.createdAt).toLocaleDateString("de-CH");
      for (const value of [user.name, user.username, created]) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      }
      const actions = document.createElement("td");
      const del = document.createElement("button");
      del.className = "btn btn-danger btn-sm";
      del.textContent = "Löschen";
      del.addEventListener("click", () => {
        if (confirm(`Benutzer «${user.username}» wirklich löschen?`)) {
          Auth.deleteUser(user.username);
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

  function openUsers() {
    renderUsers();
    dlgUsers.showModal();
  }

  // Login
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    try {
      await Auth.login(form.username.value, form.password.value);
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
      await Auth.adminLogin(form.password.value);
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
      await Auth.createUser({
        name: form.elements.name.value,
        username: form.username.value,
        password: form.password.value,
      });
      form.reset();
      showError(form);
      renderUsers();
    } catch (err) {
      showError(form, err.message);
    }
  });

  btnLogout.addEventListener("click", () => {
    Auth.logout();
    render();
  });

  document.querySelectorAll("[data-close]").forEach((btn) =>
    btn.addEventListener("click", () => btn.closest("dialog").close())
  );

  render();
})();
