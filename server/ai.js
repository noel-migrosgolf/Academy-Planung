// KI-Assistent: Chat mit Claude, der die Planung lesen und ändern kann.
// Jede Änderung wird als Version gespeichert und lässt sich im Chat rückgängig machen.
//
// Token sparen: knapper System-Prompt, Prompt-Caching, Werkzeuge mit kompakten Textantworten,
// Sammel-Aktionen statt Einzelaufrufen, wenig Denkaufwand (AI_EFFORT, Standard «low»).
// Der Verlauf eines Chats wird nur angehängt, nie umgeschrieben (Voraussetzung für Caching
// und die Denkblöcke des Modells).

const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const { pool } = require("./db");
const auth = require("./auth");
const planning = require("./planning");
const history = require("./history");
const { ValidationError } = require("./events");

const MODEL = process.env.AI_MODEL || "claude-opus-5-5";
const EFFORT = process.env.AI_EFFORT || "low";
const MAX_STEPS = 25; // Werkzeug-Runden pro Nachricht
const LONG_CHAT_TOKENS = 100000; // ab hier Hinweis «neuer Chat spart Tokens»

let client = null;
function anthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  // Schlüssel ohne festen Workspace brauchen die Workspace-ID als Header.
  const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
  client ??= new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
  return client;
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_chats (
      id            SERIAL PRIMARY KEY,
      owner         TEXT NOT NULL,
      title         TEXT NOT NULL DEFAULT 'Neuer Chat',
      system        TEXT NOT NULL,
      messages      JSONB NOT NULL DEFAULT '[]',
      display       JSONB NOT NULL DEFAULT '[]',
      notes         JSONB NOT NULL DEFAULT '[]',
      usage         JSONB NOT NULL DEFAULT '{}',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS ai_chats_owner ON ai_chats (owner, updated_at DESC);
    ALTER TABLE ai_chats
      ADD COLUMN IF NOT EXISTS tools   JSONB,
      ADD COLUMN IF NOT EXISTS running BOOLEAN NOT NULL DEFAULT false;
    -- Nach einem Neustart läuft keine Antwort mehr.
    UPDATE ai_chats SET running = false WHERE running;
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// --- System-Prompt (pro Chat beim Anlegen festgehalten, danach unverändert) ---

const BASE_PROMPT = `Du bist der Planungsassistent der AI Academy Golf (Golfpark Holzhäusern). Du planst die Einsätze der Golf-Pros im Planungstool und beantwortest Fragen zu den Daten.
Die Planung betrifft immer das Jahr 2027: Datumsangaben ohne Jahr meinen 2027, und Auswertungen, Auslastung und Planung beziehen sich nur auf 2027.

Daten
- Pros haben Sollstunden pro Jahr. Auslastung = geplante Brutto-Stunden / Sollstunden.
- Event-Typen: Brutto zählt gegen die Sollstunden, Netto ist Unterrichtszeit, der Puffer liegt am Ende. Ein Typ kann eine feste Zeit und einen festen Wochentag für den ersten Termin vorgeben. Serien-Typen legen mehrere Termine an (Abstände in Tagen ab dem ersten Termin); bei Serien sind pro Termin nur Pro und Notiz änderbar. Gib bei Serien mit «pros» pro Termin einen eigenen Pro an.
- Ein Pro kann keine zwei überschneidenden Events haben.
- Event-Typen können einen einplanbaren Zeitraum und ein Maximum an Sollstunden (brutto, über alle Pros zusammen) haben; daten_lesen zeigt beides.
- Regeln (Reiter «Regeln») legen fest, wie viele Sollstunden eines Kurses in einem Zeitraum stattfinden müssen (mindestens, genau, mehr als, höchstens) und welcher Anteil der Sollstunden von Kursen an bestimmten Wochentagen liegen muss. daten_lesen zeigt sie mit Stand. Obergrenzen sperrt das Tool, Untergrenzen erfüllt auslasten mit regeln_erfuellen, Wochentag-Anteile hält auslasten ein; beim Planen von Hand achtest du selbst darauf.
- Jeder Event-Typ hat einen Einsatzbereich (Kurse, Bambini, GCE oder alle); nur Pros mit diesem Bereich dürfen ihn übernehmen. Die Bereiche der Pros stehen bei daten_lesen unter «Einsatz».

Arbeitsweise
- Lies nur, was du brauchst: daten_lesen mit Zeitraum, Pro und Teil eingrenzen.
- Fasse Änderungen in einem Aufruf zusammen (bis 200 Einträge). Jeder Aufruf gilt ganz oder gar nicht: bei einem Fehler wird nichts geändert und du bekommst alle Fehler zurück. Korrigiere dann und rufe erneut auf.
- Für grosse Mengen (z. B. «alle Pros zu 65 % auslasten») immer auslasten verwenden statt events_anlegen: der Server verteilt die Serien selbst.
- nur_pruefen nur verwenden, wenn der Benutzer einen Vorschlag ohne Speichern möchte.
- Ist ein Auftrag unklar oder fehlt Wesentliches, frag kurz nach, statt zu raten.
- Jede Änderung erscheint im Chat mit einem Knopf «Rückgängig». Selbst zurücksetzen kannst du mit verlauf und version_wiederherstellen (nur für Admins).

Antworten: kurz, auf Deutsch (Schweizer Schreibweise, ss statt ß), Datum als TT.MM.JJJJ. Nach Änderungen eine knappe Zusammenfassung (was, wer, wie viele Stunden); lange Listen nur auf Wunsch.`;

async function rules() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'ai_rules'");
  return rows[0]?.value || "";
}

async function systemPrompt() {
  const r = (await rules()).trim();
  return r ? `${BASE_PROMPT}\n\nPlanungsregeln der Academy (immer beachten)\n${r}` : `${BASE_PROMPT}\n\nWeitere Planungsregeln gibt es noch nicht; beachte Ferien, Feiertage oder freie Tage nur, wenn der Benutzer sie nennt.`;
}

// --- Werkzeuge ---

const DATE = { type: "string", description: "YYYY-MM-DD" };
const TIME = { type: "string", description: "HH:MM" };
const CHECK = { type: "boolean", description: "true = nur prüfen, nichts speichern" };

// Werkzeuge der ersten Chats; ein Chat behält seine Werkzeuge, damit sein Verlauf gültig bleibt.
const LEGACY_TOOLS = [
  {
    name: "daten_lesen",
    description: "Liest Pros (Soll, geplante Stunden, Auslastung), Event-Typen und Events als kompakte Textzeilen. Mit Zeitraum und Pro eingrenzen.",
    input_schema: {
      type: "object",
      properties: {
        teile: { type: "array", items: { type: "string", enum: ["pros", "typen", "events"] }, description: "Standard: alle" },
        von: DATE,
        bis: DATE,
        pro: { type: "string", description: "Name oder Kürzel" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "events_anlegen",
    description: "Legt Events an (Serien-Typen: ein Eintrag = ganze Serie ab datum). Ganz oder gar nicht.",
    input_schema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              typ: { type: "string", description: "Name oder ID" },
              pro: { type: "string", description: "Name oder Kürzel" },
              datum: DATE,
              von: { ...TIME, description: "HH:MM, entfällt bei fester Zeit des Typs" },
              bis: { ...TIME, description: "HH:MM, entfällt bei fester Zeit des Typs" },
              pros: { type: "array", items: { type: "string" }, description: "Serie: Pro pro Termin, leer = pro" },
              notiz: { type: "string" },
            },
            required: ["typ", "pro", "datum"],
            additionalProperties: false,
          },
        },
        nur_pruefen: CHECK,
      },
      required: ["events"],
      additionalProperties: false,
    },
  },
  {
    name: "events_aendern",
    description: "Ändert Events per id; nicht angegebene Felder bleiben. Ganz oder gar nicht.",
    input_schema: {
      type: "object",
      properties: {
        aenderungen: {
          type: "array",
          items: {
            type: "object",
            properties: {
              event_id: { type: "integer" },
              pro: { type: "string" },
              typ: { type: "string" },
              datum: DATE,
              von: TIME,
              bis: TIME,
              notiz: { type: "string" },
            },
            required: ["event_id"],
            additionalProperties: false,
          },
        },
        nur_pruefen: CHECK,
      },
      required: ["aenderungen"],
      additionalProperties: false,
    },
  },
  {
    name: "events_loeschen",
    description: "Löscht Events per id. ganze_serie = alle Termine der Serie mitlöschen.",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "integer" } },
        ganze_serie: { type: "boolean" },
        nur_pruefen: CHECK,
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
  {
    name: "verlauf",
    description: "Letzte Versionen der Daten (id|Zeit|wer|was).",
    input_schema: {
      type: "object",
      properties: { anzahl: { type: "integer", description: "Standard 10" } },
      additionalProperties: false,
    },
  },
  {
    name: "version_wiederherstellen",
    description: "Setzt alle Pros, Typen und Events auf den Stand einer Version zurück (nur Admins).",
    input_schema: {
      type: "object",
      properties: { version_id: { type: "integer" } },
      required: ["version_id"],
      additionalProperties: false,
    },
  },
];

const AUTOFILL_TOOL = {
  name: "auslasten",
  description: "Plant automatisch Serien der gewählten Typen, gleichmässig über den Zeitraum verteilt, bis die Pros die Ziel-Auslastung erreichen (Brutto in % der Sollstunden, bestehende Events zählen mit). Ohne Überschneidungen. Für grosse Mengen statt events_anlegen.",
  input_schema: {
    type: "object",
    properties: {
      ziel_prozent: { type: "number", description: "z. B. 65" },
      pros: { type: "array", items: { type: "string" }, description: "Name oder Kürzel; leer = alle mit Sollstunden" },
      typen: { type: "array", items: { type: "string" }, description: "Name oder ID; leer = alle mit fester Zeit" },
      von: { ...DATE, description: "Standard 2027-01-01" },
      bis: { ...DATE, description: "Standard 2027-12-31" },
      freie_tage_beachten: { type: "boolean", description: "freie Wochentage der Pros auslassen" },
      regeln_erfuellen: { type: "boolean", description: "zuerst die Mindest-Stunden der Regeln auffüllen" },
      nur_pruefen: CHECK,
    },
    required: ["ziel_prozent"],
    additionalProperties: false,
  },
};

const TOOLS = [
  ...LEGACY_TOOLS.slice(0, 4),
  AUTOFILL_TOOL,
  LEGACY_TOOLS[4],
  { ...LEGACY_TOOLS[5], description: "Setzt die Events (Zuweisungen) auf den Stand einer Version zurück; Pros und Typen bleiben (nur Admins)." },
];

const actor = (session) => `${session.name} (KI)`;
const canRestore = (session) => ["admin", "api"].includes(session.role);

// Ergebnis einer Sammel-Aktion als kurzer Text für das Modell
function resultText(result, verb, list) {
  if (result.errors.length) {
    const head = result.dryRun ? "Prüfung: Fehler" : "FEHLER, nichts geändert";
    return `${head}:\n${result.errors.map((e) => `- ${e.fehler}`).join("\n")}`;
  }
  const ids = list.map((e) => e.id);
  const idText = result.dryRun ? "" : ` (ids ${ids.join(",")})`;
  return `${result.dryRun ? "Prüfung OK, würde" : "OK,"} ${list.length} Termine ${verb}${idText}.`;
}

// Stand vor einer Änderung: die neueste Version, falls sie den aktuellen Daten entspricht, sonst eine neue.
async function versionBefore(session) {
  const latest = await history.latestId();
  if (latest && (await history.matchesCurrent(latest))) return latest;
  return history.record(actor(session), "Stand vor KI-Änderung");
}

// Führt eine Änderung aus und hält sie als rückgängig machbare Version fest.
// undoOf(result) beschreibt, wie sich genau diese Änderung zurücknehmen lässt.
async function change(ctx, describe, run, undoOf) {
  const result = await run();
  if (result.dryRun || result.errors.length) return result;
  const text = await describe(result);
  await history.record(actor(ctx.session), text);
  ctx.items.push({ type: "change", text, undo: undoOf(result) });
  return result;
}

async function runTool(ctx, name, input) {
  const dryRun = input.nur_pruefen === true;
  switch (name) {
    case "daten_lesen": {
      const o = await planning.overview({ from: input.von, to: input.bis, pro: input.pro });
      return planning.overviewText(o, { maxEvents: 300, parts: input.teile?.length ? input.teile : undefined });
    }
    case "events_anlegen": {
      const r = await change(ctx,
        async (r) => `KI plant: ${await planning.describeEvents(r.created)}`,
        () => planning.bulkCreate(input.events, { dryRun, userId: ctx.session.id || null }),
        (r) => ({ created: r.created.map((e) => ({ id: e.id, created_at: e.created_at })) }));
      return resultText(r, r.dryRun ? "anlegen" : "angelegt", r.created);
    }
    case "events_aendern": {
      const r = await change(ctx,
        async (r) => `KI ändert: ${await planning.describeEvents(r.updated)}`,
        () => planning.bulkUpdate(input.aenderungen, { dryRun }),
        (r) => ({ updated: r.previous }));
      return resultText(r, r.dryRun ? "ändern" : "geändert", r.updated);
    }
    case "events_loeschen": {
      const r = await change(ctx,
        async (r) => `KI löscht: ${await planning.describeEvents(r.deleted)}`,
        () => planning.bulkDelete(input.ids, { serie: input.ganze_serie === true, dryRun }),
        (r) => ({ deleted: r.deleted }));
      return resultText(r, r.dryRun ? "löschen" : "gelöscht", r.deleted);
    }
    case "auslasten": {
      const r = await change(ctx,
        async (r) => `KI lastet aus: ${r.summary.length} Pros auf ${input.ziel_prozent} % (${r.created.length} Termine)`,
        () => planning.autoFill(input, { dryRun, userId: ctx.session.id || null }),
        (r) => ({ created: r.created.map((e) => ({ id: e.id, created_at: e.created_at })) }));
      const lines = r.summary.map((s) => s.hinweis && s.vorher_prozent === undefined
        ? `${s.pro}: ${s.hinweis}`
        : `${s.pro}: ${s.vorher_prozent}% → ${s.nachher_prozent}% (${Object.entries(s.serien).map(([t, n]) => `${t}×${n}`).join(", ") || "nichts neu"})${s.hinweis ? ` – ${s.hinweis}` : ""}`);
      const ruleLines = (r.regeln || []).map((g) => `Regel ${g.erfuellt ? "erfüllt" : "NICHT erfüllt"}: ${g.regel} (${g.vorher} → ${g.nachher})`);
      return `${r.dryRun ? "Prüfung, nichts gespeichert" : `OK, ${r.created.length} Termine angelegt`}:\n${[...lines, ...ruleLines].join("\n")}`;
    }
    case "verlauf": {
      const n = Math.min(Math.max(Number.parseInt(input.anzahl, 10) || 10, 1), 50);
      const list = (await history.list()).slice(0, n);
      return list.map((v) =>
        [v.id, new Date(v.created_at).toLocaleString("de-CH", { timeZone: "Europe/Zurich" }), v.actor, v.description].join("|")
      ).join("\n");
    }
    case "version_wiederherstellen": {
      if (!canRestore(ctx.session)) return "FEHLER: Nur Admins dürfen Versionen wiederherstellen.";
      const before = await versionBefore(ctx.session);
      const after = await history.restore(Number.parseInt(input.version_id, 10) || 0, actor(ctx.session));
      if (!after) return "FEHLER: Version nicht gefunden.";
      ctx.items.push({ type: "change", text: `KI setzt zurück auf Version #${input.version_id}`, before, after });
      return `OK, Stand von Version #${input.version_id} wiederhergestellt.`;
    }
    default:
      return `FEHLER: Unbekanntes Werkzeug ${name}.`;
  }
}

async function executeTool(ctx, block) {
  ctx.items.push({ type: "tool", text: TOOL_LABELS[block.name] || block.name });
  try {
    return { type: "tool_result", tool_use_id: block.id, content: await runTool(ctx, block.name, block.input || {}) };
  } catch (err) {
    if (!(err instanceof ValidationError)) console.error("KI-Werkzeug fehlgeschlagen:", err);
    const message = err instanceof ValidationError ? err.message : "Interner Fehler beim Ausführen.";
    return { type: "tool_result", tool_use_id: block.id, content: `FEHLER: ${message}`, is_error: true };
  }
}

const TOOL_LABELS = {
  daten_lesen: "liest Daten",
  events_anlegen: "plant Events",
  events_aendern: "ändert Events",
  events_loeschen: "löscht Events",
  auslasten: "verteilt Kurse",
  verlauf: "liest Verlauf",
  version_wiederherstellen: "stellt Version wieder her",
};

// --- Gespräch mit dem Modell ---

function addUsage(total, usage, model) {
  const u = { ...total };
  u.input = (u.input || 0) + (usage.input_tokens || 0);
  u.cache_read = (u.cache_read || 0) + (usage.cache_read_input_tokens || 0);
  u.cache_write = (u.cache_write || 0) + (usage.cache_creation_input_tokens || 0);
  u.output = (u.output || 0) + (usage.output_tokens || 0);
  u.last_context = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  u.model = model;
  return u;
}

// Wird das Ausweichmodell (Beta) vom Konto abgelehnt, läuft die KI ohne es weiter.
let fallbacksRejected = false;

function apiMessage(err) {
  return err.error?.error?.message || err.message || "";
}

async function request(system, tools, messages) {
  const params = {
    model: MODEL,
    max_tokens: 16000,
    system,
    tools,
    messages,
    output_config: { effort: EFFORT },
    cache_control: { type: "ephemeral" },
  };
  // Lehnt das Modell eine Anfrage aus Sicherheitsgründen ab, übernimmt serverseitig ein Ausweichmodell.
  if (process.env.AI_FALLBACKS !== "off" && !/haiku/.test(MODEL) && !fallbacksRejected) {
    try {
      return await anthropic().beta.messages.create({
        ...params,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } catch (err) {
      if (!(err instanceof Anthropic.APIError) || err.status !== 400 || !/fallback/i.test(apiMessage(err))) throw err;
      console.error("KI: Anfrage mit Ausweichmodell abgelehnt, weiter ohne:", apiMessage(err));
      fallbacksRejected = true;
    }
  }
  return anthropic().messages.create(params);
}

// Hängt eine Benutzer-Nachricht an; folgt sie direkt auf eine Benutzer-Nachricht
// (z. B. nach einem Abbruch), werden die Inhalte zusammengelegt.
function appendUser(messages, blocks) {
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content;
    return [...messages.slice(0, -1), { role: "user", content: [...content, ...blocks] }];
  }
  return [...messages, { role: "user", content: blocks }];
}

// onProgress(items) wird nach jedem Schritt aufgerufen (Live-Anzeige im Chat).
async function converse(chat, session, text, onProgress) {
  const ctx = { session, items: [] };
  const tools = chat.tools || LEGACY_TOOLS;
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
  const notes = chat.notes.map((n) => ({ type: "text", text: `[Hinweis: ${n}]` }));
  const first = chat.messages.length === 0 ? [{ type: "text", text: `[Heute: ${today}]` }] : [];
  const start = chat.messages;
  let messages = appendUser(start, [...first, ...notes, { type: "text", text }]);
  let usage = chat.usage;
  let fallbackModel = null;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await request(chat.system, tools, messages);
      usage = addUsage(usage, response.usage || {}, response.model);
      if (response.model && response.model !== MODEL) fallbackModel = response.model;

      if (response.stop_reason === "refusal") {
        throw Object.assign(new Error("refusal"), { userMessage: "Die KI hat diese Anfrage abgelehnt. Bitte anders formulieren." });
      }
      const toolUses = response.content.filter((b) => b.type === "tool_use");
      if (response.stop_reason === "max_tokens" && toolUses.length) {
        throw Object.assign(new Error("max_tokens"), { userMessage: "Die Antwort war zu lang. Bitte den Auftrag aufteilen." });
      }
      messages = [...messages, { role: "assistant", content: response.content }];
      for (const b of response.content) {
        if (b.type === "text" && b.text.trim()) ctx.items.push({ type: "assistant", text: b.text });
      }
      if (response.stop_reason !== "tool_use" || !toolUses.length) {
        if (response.stop_reason === "max_tokens") ctx.items.push({ type: "info", text: "Antwort abgeschnitten." });
        break;
      }
      await onProgress(ctx.items);
      const results = [];
      for (const block of toolUses) {
        results.push(await executeTool(ctx, block));
        await onProgress(ctx.items);
      }
      messages = [...messages, { role: "user", content: results }];
      if (step === MAX_STEPS - 1) ctx.items.push({ type: "info", text: "Zu viele Schritte – bitte den Auftrag aufteilen oder «weiter» schreiben." });
    }
    chat.notes = [];
  } catch (err) {
    // Ganze Runde verwerfen, damit der Verlauf gültig bleibt; gemachte Änderungen erfährt die KI als Hinweis.
    messages = start;
    const made = ctx.items.filter((i) => i.type === "change").map((i) => i.text);
    if (made.length) chat.notes = [...chat.notes, `In einer abgebrochenen Anfrage wurde bereits geändert: ${made.join("; ")}`];
    if (err.userMessage) {
      ctx.items.push({ type: "error", text: err.userMessage });
    } else if (err instanceof Anthropic.APIError) {
      console.error("KI-Anfrage fehlgeschlagen:", err.status, apiMessage(err));
      const busy = err.status === 429 || err.status === 529 || err.status >= 500;
      ctx.items.push({
        type: "error",
        text: err.status === 401 ? "Der KI-Schlüssel (ANTHROPIC_API_KEY) ist ungültig."
          : busy ? "Die KI ist gerade ausgelastet. Bitte gleich nochmals versuchen."
          : `Die KI-Anfrage ist fehlgeschlagen (${err.status ?? "Netzwerk"}): ${apiMessage(err)}`,
      });
    } else {
      console.error("KI-Lauf fehlgeschlagen:", err);
      ctx.items.push({ type: "error", text: "Interner Fehler. Bitte nochmals versuchen." });
    }
  }
  if (fallbackModel) ctx.items.push({ type: "info", text: `Beantwortet vom Ausweichmodell ${fallbackModel}.` });
  return { messages, usage, items: ctx.items };
}

// --- Routen ---

const router = express.Router();
router.use(auth.requireLogin);

const ownerOf = (session) => (session.id ? `user:${session.id}` : session.role);
const busy = new Set(); // Chats, die gerade antworten

async function loadChat(req, res) {
  const { rows } = await pool.query("SELECT * FROM ai_chats WHERE id = $1 AND owner = $2", [
    Number.parseInt(req.params.id, 10) || 0,
    ownerOf(req.session),
  ]);
  if (!rows[0]) res.status(404).json({ error: "Chat nicht gefunden." });
  return rows[0];
}

function publicChat(chat) {
  return {
    id: chat.id,
    title: chat.title,
    items: chat.display.map(({ undo, before, after, ...item }) => item), // Rückgängig-Daten bleiben auf dem Server
    usage: chat.usage,
    running: chat.running,
    long: (chat.usage.last_context || 0) > LONG_CHAT_TOKENS,
  };
}

router.get("/status", async (req, res) => {
  res.json({
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
    model: MODEL,
    effort: EFFORT,
    rules: await rules(),
    canEditRules: req.session.role === "admin",
  });
});

router.put("/rules", auth.requireAdmin, async (req, res) => {
  const value = String(req.body.rules ?? "").slice(0, 20000);
  await pool.query(
    "INSERT INTO settings (key, value) VALUES ('ai_rules', $1) ON CONFLICT (key) DO UPDATE SET value = $1",
    [value]
  );
  res.json({ ok: true, rules: value });
});

router.get("/chats", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, title, updated_at FROM ai_chats WHERE owner = $1 ORDER BY updated_at DESC LIMIT 30",
    [ownerOf(req.session)]
  );
  res.json({ chats: rows });
});

router.post("/chats", async (req, res) => {
  const { rows } = await pool.query("INSERT INTO ai_chats (owner, system, tools) VALUES ($1, $2, $3) RETURNING *", [
    ownerOf(req.session),
    await systemPrompt(),
    JSON.stringify(TOOLS),
  ]);
  res.status(201).json({ chat: publicChat(rows[0]) });
});

router.get("/chats/:id", async (req, res) => {
  const chat = await loadChat(req, res);
  if (chat) res.json({ chat: publicChat(chat) });
});

router.delete("/chats/:id", async (req, res) => {
  await pool.query("DELETE FROM ai_chats WHERE id = $1 AND owner = $2", [Number.parseInt(req.params.id, 10) || 0, ownerOf(req.session)]);
  res.json({ ok: true });
});

router.post("/chats/:id/messages", async (req, res) => {
  if (!anthropic()) return res.status(503).json({ error: "Die KI ist nicht eingerichtet (ANTHROPIC_API_KEY fehlt auf dem Server)." });
  const text = String(req.body.text || "").trim().slice(0, 8000);
  if (!text) return res.status(400).json({ error: "Bitte eine Nachricht eingeben." });
  const chat = await loadChat(req, res);
  if (!chat) return;
  if (busy.has(chat.id)) return res.status(409).json({ error: "Die KI antwortet noch auf die letzte Nachricht." });
  busy.add(chat.id);
  // Die Antwort läuft im Hintergrund weiter; der Chat zeigt den Fortschritt (Abfrage per GET).
  const base = [...chat.display, { type: "user", text }];
  const title = chat.display.length ? chat.title : text.replace(/\s+/g, " ").slice(0, 60);
  try {
    const { rows } = await pool.query(
      "UPDATE ai_chats SET display = $2, title = $3, running = true, updated_at = now() WHERE id = $1 RETURNING *",
      [chat.id, JSON.stringify(base), title]
    );
    res.status(202).json({ chat: publicChat(rows[0]) });
  } catch (err) {
    busy.delete(chat.id);
    throw err;
  }
  runChat(chat, req.session, text, base).finally(() => busy.delete(chat.id));
});

async function runChat(chat, session, text, base) {
  const save = (items) =>
    pool.query("UPDATE ai_chats SET display = $2, updated_at = now() WHERE id = $1", [chat.id, JSON.stringify([...base, ...items])]);
  let items = [];
  try {
    const result = await converse(chat, session, text, async (current) => {
      items = current;
      await save(current);
    });
    await pool.query(
      `UPDATE ai_chats SET messages = $2, display = $3, notes = $4, usage = $5, running = false, updated_at = now()
        WHERE id = $1`,
      [chat.id, JSON.stringify(result.messages), JSON.stringify([...base, ...result.items]), JSON.stringify(chat.notes), JSON.stringify(result.usage)]
    );
  } catch (err) {
    console.error("KI-Chat konnte nicht gespeichert werden:", err);
    await pool
      .query("UPDATE ai_chats SET display = $2, running = false WHERE id = $1", [
        chat.id,
        JSON.stringify([...base, ...items, { type: "error", text: "Interner Fehler. Bitte nochmals versuchen." }]),
      ])
      .catch(() => {});
  }
}

// Macht eine Änderung aus dem Chat rückgängig. Event-Änderungen werden gezielt zurückgenommen
// (andere Daten bleiben unberührt). Eine von der KI wiederhergestellte Version setzt dagegen den ganzen
// Stand zurück; wurde seither weiter geplant, ist dafür «force» nötig – das dürfen nur Admins.
router.post("/chats/:id/undo", async (req, res) => {
  const chat = await loadChat(req, res);
  if (!chat) return;
  const index = Number.parseInt(req.body.index, 10);
  const item = chat.display[index];
  if (!item || item.type !== "change") return res.status(400).json({ error: "Änderung nicht gefunden." });
  if (item.undone) return res.status(409).json({ error: "Diese Änderung wurde bereits rückgängig gemacht." });
  if (chat.running) return res.status(409).json({ error: "Die KI arbeitet noch. Bitte warten, bis sie fertig ist." });
  if (item.undo) {
    const result = await planning.undoChange(item.undo);
    if (result.errors.length) {
      return res.status(409).json({
        error: `Rückgängig nicht möglich, nichts geändert: ${result.errors.map((e) => e.fehler).join(" ")}`,
      });
    }
    await history.record(`${req.session.name} (KI rückgängig)`, `Rückgängig: ${item.text}`);
    return markUndone(res, chat, index, `Der Benutzer hat «${item.text}» rückgängig gemacht (nur diese Änderung).`);
  }
  if (!(await history.matchesCurrent(item.after))) {
    if (!(req.body.force === true && canRestore(req.session))) {
      return res.status(409).json({
        error: canRestore(req.session)
          ? "Seit dieser Änderung wurde weiter geplant. Zurücksetzen verwirft auch diese späteren Änderungen."
          : "Seit dieser Änderung wurde weiter geplant. Nur Admins können trotzdem zurücksetzen.",
        canForce: canRestore(req.session),
      });
    }
  }
  if (!(await history.restore(item.before, `${req.session.name} (KI rückgängig)`))) {
    return res.status(404).json({ error: "Die Version vor dieser Änderung ist nicht mehr vorhanden." });
  }
  await markUndone(res, chat, index, `Der Benutzer hat «${item.text}» rückgängig gemacht; die Daten sind wieder wie vor dieser Änderung.`);
});

async function markUndone(res, chat, index, note) {
  const display = chat.display.map((d, i) => (i === index ? { ...d, undone: true } : d));
  const { rows } = await pool.query(
    "UPDATE ai_chats SET display = $2, notes = $3, updated_at = now() WHERE id = $1 RETURNING *",
    [chat.id, JSON.stringify(display), JSON.stringify([...chat.notes, note])]
  );
  res.json({ chat: publicChat(rows[0]) });
}

module.exports = { router, migrate };
