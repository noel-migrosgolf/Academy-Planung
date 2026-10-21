// KI-Assistent: Chat mit Verlauf, Änderungen mit «Rückgängig», Regeln (Admins).
(function () {
  const { el } = window.Dates;
  const $ = (sel) => document.querySelector(sel);

  let ctx = null; // { api, toast, reload }
  let status = null;
  let chats = [];
  let chat = null; // aktueller Chat { id, title, items, usage, long }
  let sending = false;

  const SUGGESTIONS = [
    "Wie stark sind die Pros aktuell ausgelastet?",
    "Was ist im Januar 2027 geplant?",
    "Plane Aaron am 10.01.2027 von 13:00 bis 14:00 eine Einzelstunde.",
  ];

  // Sehr einfaches Markdown: **fett**, `code`, Listen, Absätze
  function inline(text) {
    const frag = document.createDocumentFragment();
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    for (const part of parts) {
      if (/^\*\*[^*]+\*\*$/.test(part)) frag.append(el("strong", "", part.slice(2, -2)));
      else if (/^`[^`]+`$/.test(part)) frag.append(el("code", "", part.slice(1, -1)));
      else if (part) frag.append(document.createTextNode(part));
    }
    return frag;
  }

  function markdown(text) {
    const box = el("div", "ki-md");
    let list = null;
    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();
      const item = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
      if (item) {
        list ??= box.appendChild(el("ul"));
        const li = el("li");
        li.append(inline(item[1]));
        list.append(li);
        continue;
      }
      list = null;
      if (!line.trim()) continue;
      const heading = /^#{1,4}\s+(.*)$/.exec(line);
      const p = el(heading ? "h4" : "p");
      p.append(inline(heading ? heading[1] : line));
      box.append(p);
    }
    return box;
  }

  function sparkle() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "currentColor");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M12 2.5l1.9 5.2a3 3 0 0 0 1.8 1.8l5.3 2-5.3 2a3 3 0 0 0-1.8 1.8L12 20.5l-1.9-5.2a3 3 0 0 0-1.8-1.8l-5.3-2 5.3-2a3 3 0 0 0 1.8-1.8z");
    svg.append(path);
    return svg;
  }

  function renderChats() {
    const ul = $("#ki-chats");
    ul.replaceChildren();
    if (!chats.length) ul.append(el("li", "ki-none", "Noch keine Chats"));
    for (const c of chats) {
      const li = el("li", c.id === chat?.id ? "on" : "");
      const open = el("button", "ki-chat-btn", c.title);
      open.type = "button";
      open.title = c.title;
      open.addEventListener("click", () => openChat(c.id));
      const del = el("button", "ki-chat-del", "×");
      del.type = "button";
      del.title = "Chat löschen";
      del.addEventListener("click", () => deleteChat(c.id));
      li.append(open, del);
      ul.append(li);
    }
  }

  function renderEmpty(box) {
    const hello = el("div", "ki-hello");
    const orb = el("div", "ki-orb");
    orb.append(sparkle());
    hello.append(orb, el("h3", "", "Wie kann ich bei der Planung helfen?"));
    const chips = el("div", "ki-suggest");
    for (const s of SUGGESTIONS) {
      const b = el("button", "ki-chip", s);
      b.type = "button";
      b.addEventListener("click", () => {
        $("#ki-input").value = s;
        send();
      });
      chips.append(b);
    }
    hello.append(chips);
    box.append(hello);
  }

  function renderMessages(pendingText) {
    const box = $("#ki-msgs");
    box.replaceChildren();
    const items = chat?.items || [];
    if (!items.length && !pendingText) return renderEmpty(box);

    let tools = null; // aufeinanderfolgende Werkzeug-Schritte in einer Zeile
    items.forEach((item, index) => {
      if (item.type === "tool") {
        if (!tools) {
          tools = el("div", "ki-tools");
          tools.append(sparkle(), el("span"));
          box.append(tools);
        }
        const span = tools.lastChild;
        span.textContent = span.textContent ? `${span.textContent} · ${item.text}` : item.text;
        return;
      }
      tools = null;
      if (item.type === "user") box.append(el("div", "ki-msg user", item.text));
      else if (item.type === "assistant") {
        const m = el("div", "ki-msg ai");
        m.append(markdown(item.text));
        box.append(m);
      } else if (item.type === "change") box.append(changeCard(item, index));
      else box.append(el("div", `ki-line ${item.type}`, item.text));
    });

    if (pendingText) {
      box.append(el("div", "ki-msg user", pendingText));
      const think = el("div", "ki-thinking");
      think.append(sparkle(), el("span", "ai-text shimmer", "denkt nach …"));
      box.append(think);
    }
    box.scrollTop = box.scrollHeight;
  }

  function changeCard(item, index) {
    const card = el("div", `ki-change${item.undone ? " undone" : ""}`);
    card.append(el("span", "ki-change-ic", item.undone ? "↺" : "✓"), el("span", "ki-change-tx", item.text));
    if (item.undone) {
      card.append(el("span", "ki-change-st", "rückgängig gemacht"));
    } else {
      const btn = el("button", "btn sm", "Rückgängig");
      btn.type = "button";
      btn.addEventListener("click", () => undo(index, false, btn));
      card.append(btn);
    }
    return card;
  }

  function renderFoot() {
    const foot = $("#ki-foot");
    const u = chat?.usage || {};
    const total = (u.input || 0) + (u.cache_read || 0) + (u.cache_write || 0) + (u.output || 0);
    const parts = [];
    if (status) parts.push(`${status.model} · Aufwand ${status.effort}`);
    if (total) parts.push(`${(total / 1000).toFixed(1)}k Tokens in diesem Chat${u.cache_read ? `, davon ${(u.cache_read / 1000).toFixed(1)}k aus dem Cache` : ""}`);
    foot.replaceChildren(document.createTextNode(parts.join(" · ")));
    if (chat?.long) {
      const tip = el("button", "ki-tip", "Langer Chat – ein neuer Chat spart Tokens");
      tip.type = "button";
      tip.addEventListener("click", newChat);
      foot.append(tip);
    }
  }

  function render(pendingText) {
    renderChats();
    renderMessages(pendingText);
    renderFoot();
    const ready = status?.configured;
    $("#ki-missing").hidden = !status || ready;
    $("#ki-input").disabled = !ready || sending;
    $("#ki-send").disabled = !ready || sending;
  }

  async function loadChats() {
    ({ chats } = await ctx.api("/ai/chats"));
  }

  async function openChat(id) {
    try {
      ({ chat } = await ctx.api(`/ai/chats/${id}`));
    } catch (err) {
      ctx.toast(err.message);
      chat = null;
    }
    render();
  }

  async function newChat() {
    // Ein leerer Chat wird wiederverwendet statt einen weiteren anzulegen.
    if (chat && !chat.items.length) return $("#ki-input").focus();
    try {
      ({ chat } = await ctx.api("/ai/chats", { method: "POST" }));
      await loadChats();
    } catch (err) {
      ctx.toast(err.message);
    }
    render();
    $("#ki-input").focus();
  }

  async function deleteChat(id) {
    try {
      await ctx.api(`/ai/chats/${id}`, { method: "DELETE" });
      if (chat?.id === id) chat = null;
      await loadChats();
    } catch (err) {
      ctx.toast(err.message);
    }
    render();
  }

  async function send() {
    const input = $("#ki-input");
    const text = input.value.trim();
    if (!text || sending || !status?.configured) return;
    if (!chat) {
      try {
        ({ chat } = await ctx.api("/ai/chats", { method: "POST" }));
      } catch (err) {
        return ctx.toast(err.message);
      }
    }
    sending = true;
    input.value = "";
    autosize();
    render(text);
    try {
      const res = await ctx.api(`/ai/chats/${chat.id}/messages`, { method: "POST", body: { text } });
      chat = res.chat;
      if (res.changed) ctx.reload();
      await loadChats();
    } catch (err) {
      ctx.toast(err.message);
      input.value = text;
    } finally {
      sending = false;
      render();
      input.focus();
    }
  }

  async function undo(index, force, btn) {
    if (btn) btn.disabled = true;
    try {
      ({ chat } = await ctx.api(`/ai/chats/${chat.id}/undo`, { method: "POST", body: { index, force } }));
      ctx.toast("Änderung rückgängig gemacht");
      ctx.reload();
    } catch (err) {
      if (err.data?.canForce) {
        ctx.toast(err.message, { label: "Trotzdem zurücksetzen", run: () => undo(index, true) });
      } else {
        ctx.toast(err.message);
      }
    }
    render();
  }

  async function saveRules() {
    try {
      await ctx.api("/ai/rules", { method: "PUT", body: { rules: $("#ki-rules").value } });
      ctx.toast("Regeln gespeichert – gelten ab dem nächsten neuen Chat");
    } catch (err) {
      ctx.toast(err.message);
    }
  }

  function autosize() {
    const input = $("#ki-input");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }

  async function show() {
    try {
      status = await ctx.api("/ai/status");
      await loadChats();
      if (chat && !chats.some((c) => c.id === chat.id)) chat = null;
      if (!chat && chats[0]) ({ chat } = await ctx.api(`/ai/chats/${chats[0].id}`));
    } catch (err) {
      ctx.toast(err.message);
    }
    $("#ki-rules").value = status?.rules || "";
    $("#ki-rules").readOnly = !status?.canEditRules;
    $("#ki-rules-save").hidden = !status?.canEditRules;
    $("#ki-rules-note").textContent = status?.canEditRules
      ? "Gelten für neu gestartete Chats."
      : "Nur Admins können die Regeln bearbeiten.";
    render();
  }

  function init(context) {
    ctx = context;
    $("#ki-form").addEventListener("submit", (e) => {
      e.preventDefault();
      send();
    });
    $("#ki-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
    $("#ki-input").addEventListener("input", autosize);
    $("#ki-new").addEventListener("click", newChat);
    $("#ki-rules-save").addEventListener("click", saveRules);
  }

  window.KiPage = { init, show };
})();
