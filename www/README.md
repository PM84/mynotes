# MyNotes – Lauf-Code (Backend + Frontend)

Dieses Verzeichnis enthält den **gesamten Laufzeit-Code** der Anwendung.
Alles, was hier nicht liegt (`bindev/`, `traefik/`, `docker-compose.yml`),
wird zur Laufzeit nicht benötigt und dient nur der lokalen Entwicklung.

```
www/
├── backend/    FastAPI-Backend (Python 3.12+)
├── frontend/   React-PWA (Node 20+, Vite-Build)
└── data/       Persistente Asset-Dateien (gitignored)
```

Übergeordnetes Repo-README mit Dev-Workflow: [../README.md](../README.md)

---

## Inhalt

- [Komponenten](#komponenten)
- [Installation – Entwicklung (Docker)](#installation--entwicklung-docker)
- [Installation – Produktion](#installation--produktion)
  - [Backend](#backend)
  - [Frontend](#frontend)
  - [Reverse-Proxy](#reverse-proxy)
- [Konfiguration (Environment-Variablen)](#konfiguration-environment-variablen)
- [Datenbank-Migrationen](#datenbank-migrationen)
- [Backup & Restore](#backup--restore)
- [Erst-Login & KI-Provider](#erst-login--ki-provider)

---

## Komponenten

| Komponente | Stack | Standard-Port |
|---|---|---|
| Backend | FastAPI, SQLAlchemy 2 (async), Alembic, MariaDB 11 | 8000 |
| Frontend | React 19, Vite, Workbox-PWA, Dexie, Excalidraw 0.18 | 5173 (Dev) / statisch (Prod) |
| Datenbank | MariaDB 11.7 (utf8mb4) | 3306 |

---

## Installation – Entwicklung (Docker)

Voraussetzungen: Docker, Docker Compose v2,
[mkcert](https://github.com/FiloSottile/mkcert).

```sh
# /etc/hosts ergänzen (einmalig)
sudo sh -c 'echo "127.0.0.1 mynotes.localhost api.mynotes.localhost phpmyadmin.mynotes.localhost" >> /etc/hosts'

# Vom Repo-Root aus
bindev/start.sh
```

Dann:

- Frontend: <https://mynotes.localhost>
- Backend: <https://api.mynotes.localhost/healthz>
- phpMyAdmin: <https://phpmyadmin.mynotes.localhost>

Helper-Skripte: siehe [../README.md](../README.md#skripte-bindev).

---

## Installation – Produktion

Empfohlener Weg: **Plesk-Docker** (siehe unten). Wer kein Plesk hat, findet
darunter den klassischen Weg mit Python-venv + systemd.

---

### Deployment via Plesk-Docker (empfohlen)

Bei jedem Push nach `master` baut GitHub Actions automatisch zwei Images
und veröffentlicht sie auf der GitHub Container Registry (ghcr.io):

| Image | Inhalt |
|---|---|
| `ghcr.io/<owner>/mynotes-backend:latest` | FastAPI + Alembic (auto-migrate beim Start) |
| `ghcr.io/<owner>/mynotes-frontend:latest` | Nginx mit gebauten Vite-Assets |

`<owner>` ist der GitHub-User-/Org-Name in **Kleinbuchstaben**
(z.B. `pm84` bei Repo `PM84/lamp_server_docker`).

#### Einmalige Vorbereitung

1. **Datenbank anlegen** (MariaDB ist auf dem Plesk-Server bereits vorhanden):
   ```sh
   mariadb -uroot -p <<'SQL'
   CREATE DATABASE mynotes CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'mynotes'@'localhost' IDENTIFIED BY 'STRONG_PW';
   CREATE USER 'mynotes'@'127.0.0.1' IDENTIFIED BY 'STRONG_PW';
   GRANT ALL ON mynotes.* TO 'mynotes'@'localhost';
   GRANT ALL ON mynotes.* TO 'mynotes'@'127.0.0.1';
   FLUSH PRIVILEGES;
   SQL
   ```

2. **Asset-Verzeichnis** auf dem Host anlegen (wird in den Backend-Container gemountet):
   ```sh
   mkdir -p /var/mynotes/assets && chmod 755 /var/mynotes/assets
   ```

3. **GHCR-Image öffentlich schalten** (einmalig nach dem ersten Build):
   GitHub → eigenes Profil → *Packages* → `mynotes-backend` / `mynotes-frontend`
   → *Package settings* → *Change visibility* → **Public**.
   Alternativ: privat lassen und in Plesk unter *Tools & Settings → Docker → Registries*
   ein GitHub-Personal-Access-Token mit `read:packages` hinterlegen.

#### Container in Plesk anlegen

Plesk → **Tools & Settings → Docker** → *Run Container*.

**Backend-Container** (`mynotes-backend`):

| Feld | Wert |
|---|---|
| Image | `ghcr.io/<owner>/mynotes-backend:latest` |
| Automatic start | ✅ |
| Restart Policy | `unless-stopped` |
| Port mapping | Container `8000` → Host `8001` (auf `127.0.0.1`) |
| Volume | Host `/var/mynotes/assets` → Container `/app/data/assets` |
| Environment | siehe Tabelle unten |

Environment-Variablen (Werte ersetzen):

```
DB_URL=mysql+asyncmy://mynotes:STRONG_PW@host.docker.internal:3306/mynotes
JWT_SECRET=<48 Zeichen, z.B. python -c "import secrets;print(secrets.token_urlsafe(48))">
JWT_ALG=HS256
JWT_ACCESS_MINUTES=15
JWT_REFRESH_DAYS=7
ASSET_DIR=/app/data/assets
UPLOAD_MAX_MB=64
BOOTSTRAP_ADMIN_EMAIL=admin@notes.example.com
BOOTSTRAP_ADMIN_PASSWORD=<initiales Passwort>
CORS_ORIGINS=https://notes.example.com
DEBUG=false
```

> `host.docker.internal` ist in Plesk-Docker verfügbar und zeigt auf den Host.
> Falls nicht: stattdessen die IP des Docker-Bridge-Gateways verwenden
> (`ip addr show docker0`, meist `172.17.0.1`).

**Frontend-Container** (`mynotes-frontend`):

| Feld | Wert |
|---|---|
| Image | `ghcr.io/<owner>/mynotes-frontend:latest` |
| Automatic start | ✅ |
| Restart Policy | `unless-stopped` |
| Port mapping | Container `80` → Host `8080` (auf `127.0.0.1`) |

Frontend braucht keine Environment-Variablen — die API-Basis ist im Build
fest auf `/api` gesetzt.

#### Reverse-Proxy via Plesk-Vhost

Domain `notes.example.com` → *Apache & Nginx Settings* →
**Additional nginx directives**:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:8001/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 64m;
}

location / {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

TLS/Let's-Encrypt verwaltet weiterhin Plesk.

#### Updates einspielen

GitHub-Push nach `master` → Actions baut neue Images → in Plesk-Docker beim
jeweiligen Container *Recreate* klicken. Alembic-Migrationen werden beim
Backend-Start automatisch ausgeführt.

##### Optional: Auto-Update

Plesk-Erweiterung **„Docker Images Auto-Update"** installieren (oder
[Watchtower](https://containrrr.dev/watchtower/) als zusätzlichen Container).
Dann werden `:latest`-Container automatisch neu gestartet, sobald ein neues
Image in ghcr.io liegt.

---

### Klassisch: Backend als Python-Service (Alternative)

Voraussetzungen: Python ≥ 3.12, MariaDB ≥ 11, libmagic.

```sh
# 1) Code bereitstellen
git clone <repo> /opt/mynotes
cd /opt/mynotes/www/backend

# 2) Virtualenv anlegen
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e .

# 3) Datenbank anlegen
mariadb -uroot -p <<SQL
CREATE DATABASE mynotes CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'mynotes'@'localhost' IDENTIFIED BY 'STRONG_PW';
GRANT ALL ON mynotes.* TO 'mynotes'@'localhost';
SQL

# 4) Konfiguration via .env (siehe Tabelle unten)
cp .env.example .env  # falls vorhanden, sonst manuell anlegen
$EDITOR .env

# 5) Migrationen einspielen
alembic upgrade head

# 6) Service starten (Beispiel mit uvicorn-Workern hinter systemd / nginx)
uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 2
```

Beispiel-`systemd`-Unit `/etc/systemd/system/mynotes-backend.service`:

```ini
[Unit]
Description=MyNotes Backend
After=network.target mariadb.service

[Service]
Type=simple
User=mynotes
WorkingDirectory=/opt/mynotes/www/backend
EnvironmentFile=/opt/mynotes/www/backend/.env
ExecStart=/opt/mynotes/www/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 2
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

### Frontend

Voraussetzungen: Node ≥ 20.

```sh
cd /opt/mynotes/www/frontend
npm ci
VITE_API_BASE="https://api.example.com" npm run build
# Ergebnis: dist/ — statisch ausliefern (Nginx, Caddy, Traefik file-server)
```

Nginx-Beispiel (statisches Frontend, SPA-Fallback):

```nginx
server {
    listen 443 ssl http2;
    server_name notes.example.com;
    root /opt/mynotes/www/frontend/dist;
    index index.html;
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### Reverse-Proxy

- TLS terminieren (Let's Encrypt o. ä.).
- Backend unter eigener Subdomain (z. B. `api.notes.example.com`) → Port 8000.
- `CORS_ORIGINS` im Backend auf das Frontend-Origin setzen.
- Asset-Uploads bis 64 MB → ggf. `client_max_body_size` im Proxy erhöhen.

---

## Konfiguration (Environment-Variablen)

Backend-Settings (in `.env` oder Prozess-Umgebung):

| Variable | Default | Zweck |
|---|---|---|
| `DB_URL` | `mysql+asyncmy://app:app@db:3306/mynotes` | SQLAlchemy-DSN |
| `JWT_SECRET` | *(zwingend ändern)* | HMAC-Schlüssel für Access/Refresh-Tokens |
| `JWT_ALG` | `HS256` | JWT-Signaturalgorithmus |
| `JWT_ACCESS_MINUTES` | `15` | Lebensdauer Access-Token |
| `JWT_REFRESH_DAYS` | `7` | Lebensdauer Refresh-Token |
| `ASSET_DIR` | `/app/data/assets` | Dateipfad für hochgeladene Anhänge |
| `UPLOAD_MAX_MB` | `64` | Upload-Limit pro Datei |
| `BOOTSTRAP_ADMIN_EMAIL` | `admin@example.com` | Initial-Admin (nur, wenn keiner existiert) |
| `BOOTSTRAP_ADMIN_PASSWORD` | `change-me` | Initial-Passwort |
| `CORS_ORIGINS` | `https://mynotes.localhost` | Komma-Liste erlaubter Origins |
| `DEBUG` | `0` | Verbose-Logs |

Frontend-Build-Variable:

| Variable | Zweck |
|---|---|
| `VITE_API_BASE` | Vollqualifizierte Backend-URL, z. B. `https://api.example.com` |

---

## Datenbank-Migrationen

Alembic-Setup liegt in `backend/alembic/`. Aktuelle Revisionen werden bei jedem
Deployment angewandt:

```sh
cd www/backend
alembic upgrade head      # auf neueste Revision migrieren
alembic current           # aktuelle Revision anzeigen
alembic history            # Verlauf
```

Im Dev-Container: `bindev/alembic.sh upgrade head`.

---

## Backup & Restore

Zwei Wege:

1. **Über das Admin-UI** (empfohlen): „Admin" → „Backup & Restore" →
   *Backup herunterladen* lädt ein ZIP mit allen Tabellen, Assets und
   Prompt-Texten herunter. *Backup einspielen…* spielt es zurück
   (destruktiv).
2. **Über Shell-Skripte** (Dev): [`bindev/backup.sh`](../bindev/backup.sh) erzeugt
   `mariadb-dump` + Asset-Tarball, [`bindev/restore.sh`](../bindev/restore.sh)
   spielt es ein.

> API-Keys der KI-Provider liegen in der DB im Klartext und sind im Backup
> entsprechend enthalten — Backup-Dateien sicher aufbewahren.

---

## Erst-Login & KI-Provider

1. Erst-Login mit den `BOOTSTRAP_ADMIN_*`-Credentials.
2. **Admin** → „+ Neu" → Provider anlegen (Adapter, Base-URL, API-Key).
3. „Modelle vom Provider laden" → Chat-/Embed-/Vision-Modell auswählen.
4. Aktiv-Flags setzen (genau ein Provider je Capability).
5. „Test" prüft Erreichbarkeit.

Unterstützte Adapter: `openai`, `anthropic`, `gemini`, `ollama`, `compatible`
(OpenAI-kompatible APIs).
