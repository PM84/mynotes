#!/usr/bin/env bash
# Bash in einem Service. Default: backend.
source "$( dirname "${BASH_SOURCE[0]}" )/_lib.sh"
SERVICE="${1:-backend}"
shift || true
if [ $# -eq 0 ]; then
    $COMPOSE exec -it "$SERVICE" bash || $COMPOSE exec -it "$SERVICE" sh
else
    $COMPOSE exec -it "$SERVICE" bash -lc "$*"
fi
