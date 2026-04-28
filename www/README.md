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

Bei jedem Push nach `mynotes` baut GitHub Actions automatisch zwei Images
und veröffentlicht sie auf der GitHub Container Registry (ghcr.io):

| Image | Inhalt |
|---|---|
| `ghcr.io/<owner>/mynotes-backend:<tag>` | FastAPI + Alembic (auto-migrate beim Start) |
| `ghcr.io/<owner>/mynotes-frontend:<tag>` | Nginx mit gebauten Vite-Assets |

`<owner>` ist der GitHub-User-/Org-Name in **Kleinbuchstaben**
(z.B. `pm84` bei Repo `PM84/mynotes`).

Verfügbare Tags pro Push:
- `:mynotes` — neueste Version vom Branch (zum Deployen verwenden)
- `:sha-xxxxxxx` — exakter Commit (für Rollbacks)
- `:latest` — **nur wenn `mynotes` der Default-Branch des Repos ist**

> Solange auf GitHub `master` der Default-Branch ist, gibt es **kein**
> `:latest`-Tag. Entweder den Default-Branch in den Repo-Settings auf
> `mynotes` umstellen, oder in Plesk das Tag `:mynotes` verwenden.

---

#### Schritt-für-Schritt-Checkliste

1. **GitHub-Actions-Run prüfen**
   <https://github.com/PM84/mynotes/actions> — beide Matrix-Jobs
   („backend" und „frontend") müssen grün sein.

   > Falls der Run mit `403 Forbidden` beim Push nach GHCR abbricht: alte
   > Packages unter <https://github.com/PM84?tab=packages> löschen und
   > einen leeren Commit pushen, damit der Workflow die Packages neu
   > anlegt (mit korrekter Repo-Verknüpfung).

2. **Default-Branch (optional, einmalig)**
   GitHub → Repo → *Settings → Branches → Default branch* auf `mynotes`
   setzen, damit ein `:latest`-Tag entsteht. Sonst stets das Tag
   `:mynotes` verwenden.

3. **Packages auf public stellen**
   GitHub → eigenes Profil → *Packages* → `mynotes-backend` öffnen →
   *Package settings → Change visibility → Public*. Wiederholen für
   `mynotes-frontend`.
   Privat lassen geht auch — dann braucht der Server `docker login`
   (siehe Schritt 6).

4. **Auf dem Plesk-Server einloggen** (SSH als root) und vorbereiten:
   ```sh
   # Asset-Volume anlegen
   mkdir -p /var/mynotes/assets
   chown 1000:1000 /var/mynotes/assets   # uid des Container-Users
   chmod 755 /var/mynotes/assets

   # MariaDB-Datenbank + User anlegen
   mariadb -uroot <<'SQL'
   CREATE DATABASE mynotes CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   CREATE USER 'mynotes'@'localhost'  IDENTIFIED BY 'STRONG_PW';
   CREATE USER 'mynotes'@'127.0.0.1'  IDENTIFIED BY 'STRONG_PW';
   CREATE USER 'mynotes'@'172.17.0.%' IDENTIFIED BY 'STRONG_PW';
   GRANT ALL ON mynotes.* TO 'mynotes'@'localhost';
   GRANT ALL ON mynotes.* TO 'mynotes'@'127.0.0.1';
   GRANT ALL ON mynotes.* TO 'mynotes'@'172.17.0.%';
   FLUSH PRIVILEGES;
   SQL
   ```

   > Der Eintrag für `172.17.0.%` ist nötig, weil der Backend-Container
   > die MariaDB über das Docker-Bridge-Netz erreicht.

5. **JWT-Secret erzeugen** (auf dem Plesk-Server):
   ```sh
   python3 -c "import secrets; print(secrets.token_urlsafe(48))"
   ```
   Notieren — wird gleich als `JWT_SECRET` eingetragen.

6. **Bei GHCR einloggen** (auf dem Plesk-Server, als root)

   Wenn die Packages privat sind oder GHCR Anonymous-Pulls drosselt:
   ```sh
   echo "<DEIN_GITHUB_PAT>" | docker login ghcr.io -u PM84 --password-stdin
   ```
   PAT erstellen unter <https://github.com/settings/tokens/new> mit
   Scope **nur** `read:packages`. Die Credentials landen in
   `/root/.docker/config.json` — dort wo Plesk-Stacks sie braucht.

   > Plesk-Stacks laufen als root. Login muss als root gemacht werden,
   > nicht im User-Home.

7. **Verfügbare Tags prüfen** (Vorsichtsmaßnahme gegen `manifest unknown`):
   ```sh
   curl -s -u PM84:<PAT> \
     https://ghcr.io/v2/pm84/mynotes-backend/tags/list
   curl -s -u PM84:<PAT> \
     https://ghcr.io/v2/pm84/mynotes-frontend/tags/list
   ```
   Eines der gelisteten Tags (z.B. `mynotes`, `master`, `sha-1454c5a`)
   in Schritt 8 als Image-Tag verwenden. Im Browser sichtbar unter
   <https://github.com/PM84/mynotes/pkgs/container/mynotes-backend>.

8. **Stack in Plesk anlegen**
   Plesk → *Docker → Stacks → Stack hinzufügen*. Name: `mynotes`.
   Compose-Datei einfügen (Werte ersetzen, Tag aus Schritt 7 nehmen):

   ```yaml
   services:
     backend:
       image: ghcr.io/pm84/mynotes-backend:mynotes
       container_name: mynotes-backend
       restart: unless-stopped
       ports:
         - "127.0.0.1:8001:8000"
       volumes:
         - /var/mynotes/assets:/app/data/assets
       extra_hosts:
         - "host.docker.internal:host-gateway"
       environment:
         DB_URL: mysql+asyncmy://mynotes:STRONG_PW@host.docker.internal:3306/mynotes
         JWT_SECRET: REPLACE_WITH_SECRET_FROM_STEP_5
         JWT_ALG: HS256
         JWT_ACCESS_MINUTES: "15"
         JWT_REFRESH_DAYS: "7"
         ASSET_DIR: /app/data/assets
         UPLOAD_MAX_MB: "64"
         BOOTSTRAP_ADMIN_EMAIL: admin@notes.pemasoft.de
         BOOTSTRAP_ADMIN_PASSWORD: REPLACE_WITH_INITIAL_PW
         CORS_ORIGINS: https://notes.pemasoft.de
         DEBUG: "false"

     frontend:
       image: ghcr.io/pm84/mynotes-frontend:mynotes
       container_name: mynotes-frontend
       restart: unless-stopped
       ports:
         - "127.0.0.1:8080:80"
   ```

   Stack speichern + starten.

   > Falls der Pull mit `manifest unknown` abbricht: das Tag existiert
   > nicht. Schritt 7 erneut prüfen und Tag im Compose anpassen.
   > Falls `unauthorized` / `403`: `docker login` aus Schritt 6 fehlt
   > oder PAT hat keinen `read:packages`-Scope.

9. **Logs prüfen** (per SSH oder Plesk-UI: Stack → Container → Logs)
   ```sh
   docker logs mynotes-backend --tail=50
   docker logs mynotes-frontend --tail=20
   ```
   Backend-Log muss enden mit `Application startup complete`.
   `alembic upgrade head` läuft beim ersten Start automatisch.

10. **Reverse-Proxy am Vhost konfigurieren**
    Plesk → Domain `notes.pemasoft.de` → *Apache & Nginx Settings* →
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

11. **Smoke-Test**
    ```sh
    curl -fsS https://notes.pemasoft.de/api/healthz   # -> {"ok":true}
    curl -I  https://notes.pemasoft.de/               # -> 200, text/html
    ```
    Im Browser einloggen mit `BOOTSTRAP_ADMIN_EMAIL` +
    `BOOTSTRAP_ADMIN_PASSWORD`.

---

#### Updates einspielen

GitHub-Push nach `mynotes` → Actions baut neue Images. Auf dem Server:

```sh
docker compose -f /opt/psa/var/modules/docker/stacks/mynotes/compose.yaml pull
docker compose -f /opt/psa/var/modules/docker/stacks/mynotes/compose.yaml up -d
```

Oder in Plesk: *Docker → Stacks → mynotes → Neu starten* (zieht beim Start
das aktuelle Tag, falls Plesk das anbietet — sonst CLI nutzen).
Alembic-Migrationen laufen beim Backend-Start automatisch.

##### Optional: Auto-Update mit Watchtower

```sh
docker run -d \
  --name watchtower \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /root/.docker/config.json:/config.json:ro \
  containrrr/watchtower \
  --interval 300 \
  mynotes-backend mynotes-frontend
```

Watchtower nutzt deine `docker login`-Credentials aus Schritt 6 und pollt
alle 5 Minuten auf neue Image-Versionen.

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
