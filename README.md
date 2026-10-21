# AI Academy Golf – Planung

Planungstool für die AI Academy Golf im Golfpark Holzhäusern.

## Aufbau

- `server/` – Node.js/Express-Server mit API (Login, Benutzer, Pros, Events, Verlauf, KI)
- `public/` – Oberfläche (HTML/CSS/JS), Logo und Favicons unter `public/img/`
- PostgreSQL-Datenbank mit den Tabellen `users`, `sessions`, `pros`, `event_types`, `events`, `versions`, `ai_chats` und `settings`; das Schema wird beim Start automatisch angelegt bzw. ergänzt.

## Lokal starten

Voraussetzungen: Node.js 22+ und eine PostgreSQL-Datenbank.

```bash
cp .env.example .env   # Werte anpassen
npm install
npm run dev
```

Dann <http://localhost:3000> öffnen.

## Umgebungsvariablen

| Variable | Beschreibung |
|---|---|
| `DATABASE_URL` | Verbindungs-URL der PostgreSQL-Datenbank |
| `ADMIN_PASSWORD` | Passwort für den Admin-Bereich |
| `DATABASE_SSL` | `true`, wenn die Datenbank SSL verlangt (z. B. externe Render-URL) |
| `EXPORT_TOKEN` | Optional: Schlüssel für den Lesezugriff auf `GET /api/export` ohne Anmeldung (Header `X-Export-Token`) |
| `API_TOKEN` | Optional: Schlüssel für die Datenpflege über die API (Header `X-Api-Token`). Darf Pros, Event-Typen, Events und den Verlauf bearbeiten, aber keine Benutzerkonten. Löschen der Variable sperrt den Zugang sofort. |
| `ANTHROPIC_API_KEY` | Schlüssel für den KI-Assistenten (console.anthropic.com). Ohne ihn ist der Reiter KI sichtbar, aber gesperrt. |
| `ANTHROPIC_WORKSPACE_ID` | Nur nötig, wenn der Schlüssel keinem Workspace zugeordnet ist: ID des Workspace (Console → Settings → Workspaces, beginnt mit `wrkspc_`) |
| `AI_MODEL` | Optional: Modell der KI, Standard `claude-opus-5-5` (günstiger: `claude-sonnet-5-5`) |
| `AI_EFFORT` | Optional: Denkaufwand `low` (Standard, spart Tokens), `medium` oder `high` |
| `AI_FALLBACKS` | Optional: `off` schaltet das Ausweichmodell bei abgelehnten Anfragen aus |
| `NODE_ENV` | `production` auf dem Server (sichere Cookies) |

## Deployment auf Render

Siehe `render.yaml` (Blueprint) – oder manuell als Web Service mit
Build Command `npm ci` und Start Command `npm start`.

## Aktueller Stand

- **Login** wie im Event Manager: Benutzer wählen, Passwort eingeben, Ladeanimation und Begrüssung (Passwörter als scrypt-Hash in der Datenbank). Benutzer mit Admin-Rechten melden sich normal an; zusätzlich gibt es oben rechts den Notzugang mit dem Admin-Passwort (`ADMIN_PASSWORD`).
- **Kalender** (`public/js/planner.js`): Einsatzkalender der Pros mit den Ansichten Tag, Woche, Monat und Saison, Navigation per Datum und KW, Filter nach Pros und Umschalter Brutto/Netto für alle Stundensummen. In der Tagesansicht entstehen Events durch Aufziehen eines Zeitraums oder per Klick (1 h); Klick auf ein Event öffnet es zum Bearbeiten. Rechtsklick (Tag, Woche, Monat, Events-Liste) öffnet ein Menü: auf einer freien Stelle «Event erstellen» mit vorausgefülltem Pro, Datum und nächster freier Stunde, auf einem Event «Bearbeiten» und «Löschen».
- **Events** (`public/js/events.js`): Event-Typen verwalten (mit frei wählbarer, eindeutiger ID wie «PR2A», von Admins änderbar; KI und API finden Typen auch per ID). Jeder Typ hat einen Einsatzbereich (Kurse – dazu gehört auch der Einzelunterricht –, Bambini, GCE oder alle Pros); nur Pros mit diesem Bereich lassen sich einteilen (Dialog, API, KI und automatisches Auslasten). Die Typenliste lässt sich nach Bereich filtern. Pro Typ lässt sich ausserdem einstellen, wann er einplanbar ist (von–bis; alle Termine einer Serie müssen hineinfallen) und wie viele Sollstunden (brutto) er höchstens umfassen darf, über alle Pros zusammen; beides gilt überall, auch beim Auslasten und Events planen (Typ, Pro, Datum, Zeit, Notiz). Der Reiter **Geplante Events** listet alle Events mit Brutto/Netto. Event-Typen legen nur Admins an. Brutto und Netto werden pro 30 min geplanter Zeit angegeben, z. B. Einzelstunde 30/25 → 1 h = 1 h brutto (zählt gegen die Sollstunden) = 50 min netto. Der Unterricht beginnt pünktlich, der Puffer liegt gesammelt am Ende (09:00–09:50 Unterricht, 09:50–10:00 Puffer). Überschneidungen beim selben Pro werden abgelehnt. Event-Typen können ausserdem pauschale Stunden pro Termin, eine feste Uhrzeit, einen festen Wochentag für den ersten Termin und eine Serie von Terminen haben (Abstände in Tagen). Beispiel «Platzreife Teil 1 A»: 4 Termine Sa, So, Sa, So, jeweils 10:00–12:30, pro Termin 3 h brutto und 2.5 h netto (Unterricht 10:00–12:30, Puffer 12:30–13:00, der Pro ist bis 13:00 belegt); beim Anlegen lässt sich unter «Erweitert» pro Termin ein anderer Pro wählen. Optional hat jeder Termin eine eigene Zeit («Zeit pro Termin», z. B. Platzreife Teil 2 A: Sa 14:00–16:30, So 10:00–12:30, So 14:00–16:30); dann sind auch mehrere Termine am selben Tag möglich (gleicher Abstand). Serien werden gemeinsam angelegt und gelöscht; einzelne Termine lassen sich im Pro und in der Notiz ändern.
- **Auslasten** (`public/js/autofill.js`, `POST /api/autofill`): Pro Pro per Regler die Ziel-Auslastung (Brutto in % der Sollstunden) einstellen, Kurse (Event-Typen mit fester Zeit) auswählen und mit «Vorschau» prüfen oder «Ausführen». Der Server verteilt die Serien gleichmässig über 2027, ohne Überschneidungen, nur im Einsatzbereich der Pros und auf Wunsch ohne ihre freien Tage. Bestehende Events zählen mit, es wird nur ergänzt. Admins speichern die Ziele dabei als Soll-Auslastung der Pros. Das Ergebnis lässt sich direkt rückgängig machen.
- **Regeln** (`server/rules.js`, `public/js/rules.js`): Regeln der Form «Zwischen Datum x und y müssen mindestens / genau / mehr als / höchstens z Sollstunden von Kurs k stattfinden» (Brutto-Stunden über alle Pros; jeder Termin zählt mit seinem Datum). Jede Regel zeigt live, ob sie erfüllt ist. «Genau» und «höchstens» sperren das Einplanen darüber hinaus (Dialog, API, KI, Auslasten); «Auslasten» füllt mit «Regeln zuerst erfüllen» fehlende Stunden auf, verteilt auf passende Pros mit der geringsten Auslastung. Zweite Regelart: «Mindestens x % der Sollstunden von Kursen … (Mehrfachauswahl) müssen an Wochentagen / am Wochenende / Mo, Di … stattfinden»; sie wird angezeigt und von «Auslasten» eingehalten (Termine an anderen Tagen nur, solange der Anteil nicht unter x % fällt), sperrt aber das Einplanen von Hand nicht. Jede Regel hat eine ID (R1, R2 …). «Warum?» bei einer Regel (bzw. `GET /api/rules/R3/check` oder das KI-Werkzeug «regel_pruefen») erklärt Stand, Verteilung, Hindernisse und Lösung. Nur Admins legen Regeln an; sie sind nicht im Verlauf.
- **Pros**: Übersicht mit Einstellungen je Pro (Kürzel, Sollstunden, Einsatzbereiche Kurse/Bambini/GCE, freie Tage, Soll-Auslastung, Abwesenheiten, Verfügbarkeitsregel). Pro Pro wird die Auslastung 2027 angezeigt: geplante Stunden (Summe der zugewiesenen Events, brutto) in Prozent der Sollstunden, mit Balken, Markierung der Soll-Auslastung und den offenen Stunden bis zum Ziel. Admins können Pros anlegen, bearbeiten und löschen. Startwerte in `server/pros.js`.
- **Schulferien** (`public/js/calendar.js`): Jahresübersicht 2027 mit den Schulferien und schulfreien Tagen des Kantons Zug (`public/js/ferien.js`).
- **Benutzer** (nur Admin): Benutzer anlegen und löschen, Admin-Rechte pro Benutzer vergeben oder entziehen (wirkt sofort).
- **Verlauf** (nur Admin, `server/history.js`): Nach jeder Änderung an den Events (Zuweisungen: welcher Pro wann welchen Kurs hat) wird der Stand aller Events als Version gespeichert (mit Zeit, wer, was). «Wiederherstellen» setzt nur die Events zurück und ist selbst wieder eine Version. Pros, Event-Typen und Benutzerkonten werden manuell gepflegt, nicht gespeichert und beim Wiederherstellen nicht verändert (Events, deren Pro oder Typ es nicht mehr gibt, werden ausgelassen). Es werden die letzten 1000 Versionen behalten.
- **Export** (nur lesend): `GET /api/export` liefert Benutzer (ohne Passwörter), Pros, Event-Typen und Events als JSON. Admins nutzen den Button «Daten exportieren» auf der Benutzer-Seite; ohne Anmeldung nur mit Header `X-Export-Token`.
- **KI** (`server/ai.js`, `public/js/ai.js`): Chat mit Claude, der die Daten lesen und Events anlegen, ändern und löschen kann. Jede Änderung der KI wird als Version gespeichert und erscheint im Chat mit «Rückgängig». Das nimmt genau diese Änderung zurück (angelegte Events löschen, gelöschte wieder einfügen, geänderte auf die alten Werte setzen); alles andere, auch spätere Änderungen, bleibt unberührt. Gibt es einen Konflikt (z. B. inzwischen ein anderes Event zur selben Zeit), wird nichts geändert. Nur eine von der KI wiederhergestellte Version setzt beim Rückgängigmachen den ganzen Stand zurück. Die KI arbeitet im Hintergrund; der Chat zeigt laufend, was sie tut (auch nach einem Seitenwechsel). Für grosse Aufträge wie «alle Pros zu 65 % auslasten» nutzt sie das Werkzeug «auslasten»: der Server verteilt die Serien der gewählten Typen selbst gleichmässig über den Zeitraum, ohne Überschneidungen (optional unter Beachtung der freien Tage) – in Sekunden und mit wenigen Tokens. Admins pflegen unter «Regeln für die KI» die Planungsregeln; sie gelten für neu gestartete Chats. Tokensparend: knapper System-Prompt, Prompt-Caching, Werkzeuge mit kompakten Textzeilen statt JSON, Sammel-Aktionen, Denkaufwand `low`; bei langen Chats empfiehlt die Seite einen neuen Chat.
- **API für Planung** (mit Anmeldung oder `X-Api-Token`):
  - `GET /api/overview?from=YYYY-MM-DD&to=YYYY-MM-DD&pro=Name&format=text` – lesefreundliche Übersicht: Namen statt IDs, Zeiten als HH:MM, Stunden und Auslastung je Pro.
  - `POST /api/events/bulk` `{ events: [{ typ, pro, datum, von, bis, pros?, notiz? }], dry_run? }` – mehrere Events (auch Serien) in einem Aufruf.
  - `POST /api/events/bulk-update` `{ changes: [{ event_id, pro?, typ?, datum?, von?, bis?, notiz? }], dry_run? }`
  - `POST /api/events/bulk-delete` `{ ids: [...], serie?, dry_run? }`
  - Pros per Name oder Kürzel, Typen per Name, Zeiten als `HH:MM`. Jeder Aufruf gilt ganz oder gar nicht (bei Fehlern 409 und nichts geändert) und ergibt genau eine Version im Verlauf. `dry_run: true` prüft nur.
