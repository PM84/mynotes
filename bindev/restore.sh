#!/usr/bin/env bash
# Restore: tar.gz aus backup.sh wieder einspielen.
source "$( dirname "${BASH_SOURCE[0]}" )/_lib.sh"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <backup.tar.gz>" >&2
  exit 1
fi
ARCHIVE="$(realpath "$1")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Archiv entpacken"
tar -C "$TMP" -xzf "$ARCHIVE"

echo "==> DB neu erstellen"
$COMPOSE exec -T db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "DROP DATABASE IF EXISTS mynotes; CREATE DATABASE mynotes CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"'
$COMPOSE exec -T db sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" mynotes' < "$TMP/mynotes.sql"

echo "==> Assets entpacken"
mkdir -p ./www/data
rm -rf ./www/data/assets
tar -C ./www/data -xzf "$TMP/assets.tgz"

echo "==> Backend neustarten"
$COMPOSE restart backend
echo "==> Restore abgeschlossen."
