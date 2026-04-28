#!/usr/bin/env bash
# Frontend Vitest im Container ausführen.
source "$( dirname "${BASH_SOURCE[0]}" )/_lib.sh"

$COMPOSE exec -T frontend npm test "$@"
