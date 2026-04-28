#!/usr/bin/env bash
# Backup: MariaDB-Dump + Asset-Verzeichnis als tar.gz.
source "$( dirname "${BASH_SOURCE[0]}" )/_lib.sh"

OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> mariadb-dump → $TMP/mynotes.sql"
$COMPOSE exec -T db sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines --triggers mynotes' > "$TMP/mynotes.sql"

echo "==> Assets archivieren"
tar -C ./www/data -czf "$TMP/assets.tgz" assets 2>/dev/null || tar -czf "$TMP/assets.tgz" --files-from /dev/null

OUT="$OUT_DIR/mynotes-backup-$TS.tar.gz"
tar -C "$TMP" -czf "$OUT" mynotes.sql assets.tgz
echo "==> Backup geschrieben: $OUT ($(du -h "$OUT" | cut -f1))"
