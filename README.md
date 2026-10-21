# AI Academy Golf – Planung

Planungstool für die AI Academy Golf im Golfpark Holzhäusern.

## Aufbau

- `server/` – Node.js/Express-Server mit API (Login, Benutzer, Pros)
- `public/` – Oberfläche (HTML/CSS/JS), Logo und Favicons unter `public/img/`
- PostgreSQL-Datenbank mit den Tabellen `users`, `sessions` und `pros`; das Schema wird beim Start automatisch angelegt bzw. ergänzt.

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

- **Login** wie im Event Manager: Benutzer wählen, Passwort eingeben, Ladeanimation und Begrüssung (Passwörter als scrypt-Hash in der Datenbank). Benutzer mit Admin-Rechten melden sich normal an; zusätzlich gibt es oben rechts den Notzugang mit dem Admin-Passwort (`ADMIN_PASSWORD`).
- **Kalender** (`public/js/planner.js`): Einsatzkalender der Pros mit den Ansichten Tag, Woche, Monat und Saison, Navigation per Datum und KW sowie Filter nach Pros. Noch ohne Einsätze.
- **Pros**: Übersicht mit Einstellungen je Pro (Kürzel, Sollstunden, Einsatzbereiche Kurse/Bambini/GCE, freie Tage, Soll-Auslastung, Abwesenheiten, Verfügbarkeitsregel). Admins können Pros anlegen, bearbeiten und löschen. Startwerte in `server/pros.js`.
- **Schulferien** (`public/js/calendar.js`): Jahresübersicht 2027 mit den Schulferien und schulfreien Tagen des Kantons Zug (`public/js/ferien.js`).
- **Benutzer** (nur Admin): Benutzer anlegen und löschen, Admin-Rechte pro Benutzer vergeben oder entziehen (wirkt sofort).
