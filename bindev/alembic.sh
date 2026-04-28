#!/usr/bin/env bash
# Alembic-Wrapper im Backend-Container.
source "$( dirname "${BASH_SOURCE[0]}" )/_lib.sh"
$COMPOSE exec -it backend alembic "$@"
