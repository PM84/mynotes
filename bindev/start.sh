#!/usr/bin/env bash
# Startet das lokale Dev-Setup (DB + Backend + Frontend + Traefik).
source "$( dirname "${BASH_SOURCE[0]}" )/_lib.sh"

# TLS-Zertifikate prüfen
if [ ! -f traefik/certs/local-cert.pem ]; then
    echo ">>> Keine TLS-Zertifikate gefunden. Erzeuge sie mit mkcert..."
    mkdir -p traefik/certs
    if ! command -v mkcert >/dev/null 2>&1; then
        echo "FEHLER: mkcert ist nicht installiert. Siehe traefik/renew_certs.md"
        exit 1
    fi
    mkcert -install
    cd traefik
    mkcert -cert-file certs/local-cert.pem -key-file certs/local-key.pem \
        "mynotes.localhost" "*.mynotes.localhost"
    cd ..
fi

# /etc/hosts-Hinweis
if ! grep -q "mynotes.localhost" /etc/hosts; then
    cat <<EOF
WARNUNG: /etc/hosts enthält keinen Eintrag für mynotes.localhost.
Füge folgendes hinzu:
  127.0.0.1 mynotes.localhost api.mynotes.localhost phpmyadmin.mynotes.localhost traefik.localhost
EOF
fi

mkdir -p www/data/assets

$COMPOSE up -d --build "$@"

echo ""
echo ">>> MyNotes läuft:"
echo "    Frontend:    https://mynotes.localhost"
echo "    Backend-API: https://api.mynotes.localhost"
echo "    phpMyAdmin:  https://phpmyadmin.mynotes.localhost"
echo "    Traefik:     http://localhost:8080"
