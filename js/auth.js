// Vorläufige Benutzerverwaltung im Browser (localStorage).
// Wird später durch ein echtes Backend ersetzt.
(function () {
  // Vorübergehend hardcodiert (SHA-256 des Admin-Passworts) – wird mit dem Backend ersetzt.
  const ADMIN_PASSWORD_HASH = "b2764c234f6e18b6ffe224d049583173040f7dba4be5d1c9dbcf6a60492f5ccd";

  const USERS_KEY = "academy.users";
  const SESSION_KEY = "academy.session";

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  async function hash(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function randomSalt() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function getUsers() {
    return load(USERS_KEY, []);
  }

  async function createUser({ name, username, password }) {
    username = username.trim().toLowerCase();
    if (!name.trim() || !username || !password) {
      throw new Error("Bitte alle Felder ausfüllen.");
    }
    if (password.length < 6) {
      throw new Error("Passwort muss mindestens 6 Zeichen lang sein.");
    }
    const users = getUsers();
    if (users.some((u) => u.username === username)) {
      throw new Error("Benutzername ist bereits vergeben.");
    }
    const salt = randomSalt();
    users.push({
      name: name.trim(),
      username,
      salt,
      passwordHash: await hash(salt + password),
      createdAt: new Date().toISOString(),
    });
    save(USERS_KEY, users);
  }

  function deleteUser(username) {
    save(USERS_KEY, getUsers().filter((u) => u.username !== username));
  }

  async function login(username, password) {
    username = username.trim().toLowerCase();
    const user = getUsers().find((u) => u.username === username);
    if (!user || (await hash(user.salt + password)) !== user.passwordHash) {
      throw new Error("Benutzername oder Passwort falsch.");
    }
    const session = { role: "user", username: user.username, name: user.name };
    save(SESSION_KEY, session);
    return session;
  }

  async function adminLogin(password) {
    if ((await hash(password)) !== ADMIN_PASSWORD_HASH) {
      throw new Error("Admin-Passwort falsch.");
    }
    const session = { role: "admin", username: "admin", name: "Administrator" };
    save(SESSION_KEY, session);
    return session;
  }

  function getSession() {
    return load(SESSION_KEY, null);
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
  }

  window.Auth = { getUsers, createUser, deleteUser, login, adminLogin, getSession, logout };
})();
