# Academy Planung

Planungstool für die Academy Holzhäusern.

## Aufbau

- `server/` – Node.js/Express-Server mit API (Login, Benutzerverwaltung)
- `public/` – Oberfläche (HTML/CSS/JS)
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

- **Login** für Benutzer (Passwörter als scrypt-Hash in der Datenbank).
- **Admin-Bereich** (oben rechts): Benutzer anlegen und löschen.
- **Jahreskalender 2027** mit den Schulferien und schulfreien Tagen des Kantons Zug (`public/js/ferien.js`).
