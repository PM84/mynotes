#!/usr/bin/env bash
# Nextcloud-Backup: Erstellt ein ZIP-Backup und lädt es per WebDAV hoch.
# Einstellungen (Nextcloud-URL, Credentials, Retention) kommen aus der DB (Admin-UI).
#
# Cronjob-Beispiel (täglich 03:00):
#   0 3 * * * /home/peter/dev/mynotes/bindev/backup-nextcloud.sh >> /var/log/mynotes-backup.log 2>&1
source "$( dirname "${BASH_SOURCE[0]}" )/_lib.sh"

$COMPOSE exec -T backend python -m app.backup_cli
