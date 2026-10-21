# AI Academy Golf – Planung

Planungstool für die AI Academy Golf im Golfpark Holzhäusern.

## Aufbau

- `server/` – Node.js/Express-Server mit API (Login, Benutzerverwaltung)
- `public/` – Oberfläche (HTML/CSS/JS), Logo und Favicons unter `public/img/`
- PostgreSQL-Datenbank; das Schema wird beim Start automatisch angelegt.

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
| `NODE_ENV` | `production` auf dem Server (sichere Cookies) |

## Deployment auf Render

Siehe `render.yaml` (Blueprint) – oder manuell als Web Service mit
Build Command `npm ci` und Start Command `npm start`.

## Aktueller Stand

- **Login** wie im Event Manager: Benutzer wählen, Passwort eingeben, Ladeanimation und Begrüssung (Passwörter als scrypt-Hash in der Datenbank). Der Admin-Zugang liegt oben rechts.
- **Kalender** (`public/js/planner.js`): Einsatzkalender der Pros mit den Ansichten Tag, Woche, Monat und Saison, Navigation per Datum und KW sowie Filter nach Pros. Noch ohne Einsätze.
- **Pros**: Übersicht aller Pros; Admins können Pros hinzufügen und entfernen.
- **Schulferien** (`public/js/calendar.js`): Jahresübersicht 2027 mit den Schulferien und schulfreien Tagen des Kantons Zug (`public/js/ferien.js`).
- **Benutzer** (nur Admin): Benutzer anlegen und löschen.
