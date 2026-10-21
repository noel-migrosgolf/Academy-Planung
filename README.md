# Academy Planung

Planungstool für die Academy Holzhäusern.

## Starten

Statische Web-App ohne Build-Schritt. Lokal z. B. mit:

```bash
python3 -m http.server 8000
```

und dann <http://localhost:8000> öffnen.

## Aktueller Stand

- **Login** für Benutzer.
- **Admin-Bereich** (oben rechts): Benutzer anlegen und löschen. Das Admin-Passwort ist vorerst als SHA-256-Hash in `js/auth.js` hardcodiert.
- **Jahreskalender 2027** mit den Schulferien und schulfreien Tagen des Kantons Zug (`js/ferien.js`).

> Benutzer werden vorläufig nur im Browser (localStorage) gespeichert, also pro Browser/Gerät. Für den produktiven Einsatz braucht es ein Backend.
