# MyNotes – KI-gestützte Notiz-PWA

Selbst gehostete, offline-fähige Notiz-PWA mit Excalidraw-Handschrift, Datei-Anhängen,
Volltext- und semantischer Suche, KI-Zusammenfassungen, Widerspruchs-Analyse und
austauschbaren KI-Providern (OpenAI, Anthropic, Gemini, Ollama, OpenAI-kompatibel).

Konzept: siehe [KONZEPT_PWA.md](KONZEPT_PWA.md).

## Layout

| Pfad | Zweck |
|---|---|
| `www/backend/` | FastAPI-Backend (alleiniger Lauf-Code Backend) |
| `www/frontend/` | React-PWA (alleiniger Lauf-Code Frontend) |
| `www/data/` | Persistent: Asset-Dateien, von DB referenziert (gitignored) |
| `bindev/` | Helper-Scripts, **nur für lokale Entwicklung** |
| `traefik/` | Traefik v3-Reverse-Proxy (nur Dev) |
| `docker-compose.yml` | **Nur Dev**. Bind-mountet `www/`, kein App-Code im Image |

> Konvention: **Alles, was zur Laufzeit benötigt wird, liegt in `www/`.**
> Docker dient ausschließlich der lokalen Entwicklung. Für Produktion können
> Backend (Python) und Frontend (statisches Build) eigenständig deployt werden.

## Quickstart (Entwicklung)

Voraussetzungen: Docker, Docker Compose v2, [mkcert](https://github.com/FiloSottile/mkcert).

```sh
# 1) /etc/hosts ergänzen
sudo sh -c 'echo "127.0.0.1 mynotes.localhost api.mynotes.localhost phpmyadmin.mynotes.localhost" >> /etc/hosts'

# 2) Stack starten (legt mkcert-Zertifikate beim ersten Mal selbst an)
bindev/start.sh
```

Dann:

- Frontend: <https://mynotes.localhost>
- Backend:  <https://api.mynotes.localhost/healthz>
- phpMyAdmin: <https://phpmyadmin.mynotes.localhost>

Standard-Admin: `admin@mynotes.localhost` / `admin`
(änderbar in `docker-compose.yml` → `BOOTSTRAP_ADMIN_*`).

### Skripte (`bindev/`)

| Befehl | Wirkung |
|---|---|
| `bindev/start.sh` | Stack hochfahren |
| `bindev/stop.sh` | Stack stoppen |
| `bindev/restart.sh` | Neustart |
| `bindev/logs.sh [service]` | Logs verfolgen |
| `bindev/bash.sh [service]` | Shell im Container |
| `bindev/alembic.sh ...` | Alembic-Befehle |
| `bindev/db.sh` | MariaDB-CLI als root |
| `bindev/test.sh` | pytest im Backend-Container |
| `bindev/test-frontend.sh` | Vitest im Frontend-Container |
| `bindev/backup.sh [zielordner]` | DB-Dump + Assets als `mynotes-backup-YYYYMMDD-HHMMSS.tar.gz` |
| `bindev/restore.sh <archiv>` | Backup einspielen (DB drop+create, Assets ersetzen) |

### Health-Endpunkte

- `GET /healthz` – flacher Liveness-Check (immer `{"ok":true}` wenn der Prozess lebt).
- `GET /healthz/deep` – DB (`SELECT 1`) und Worker-Task; nutzbar für Monitoring.

### Sicherheit

- `POST /auth/login` ist auf 10 Versuche/Minute pro IP begrenzt (slowapi).
- Globaler Default-Limit: 240 req/min pro IP.
- Security-Header (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
  werden vom Backend gesetzt; CSP erlaubt eigene Inline-Styles und Web-Worker (PWA).
- Asset-Uploads werden per `libmagic` (Magic-Byte-Sniff) zusätzlich zum
  Content-Type-Header validiert.

### KI-Provider einrichten

1. In der Web-UI als Admin anmelden → "Admin" → "+ Neu".
2. Adapter wählen, Base-URL, API-Key, Modelle eintragen.
3. Aktivflags setzen (genau ein Provider je Capability).
4. "Test" prüft Erreichbarkeit (Health-Endpunkt des Anbieters).

## Produktion

Im Repo nicht enthalten – Empfehlung:

- Backend per `pip install` aus `www/backend/pyproject.toml`
  + `uvicorn`/`gunicorn` hinter Nginx; MariaDB nativ; Asset-Verzeichnis als Volume.
- Frontend `npm run build` → `www/frontend/dist/` als statische Auslieferung.
- Reverse-Proxy mit Let's Encrypt; CORS-Origins über `CORS_ORIGINS`.

## Konzept-Dokumente

- [KONZEPT_PWA.md](KONZEPT_PWA.md) – Master-Konzept.
- [KONZEPT.md](KONZEPT.md) / [KONZEPT_SLIM.md](KONZEPT_SLIM.md) – ältere Iterationen.
