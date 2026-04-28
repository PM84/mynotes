#!/usr/bin/env bash
# Datenbank-Shell (mariadb).
source "$( dirname "${BASH_SOURCE[0]}" )/_lib.sh"
$COMPOSE exec -it db mariadb -u app -papp mynotes
