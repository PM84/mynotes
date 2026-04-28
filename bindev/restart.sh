#!/usr/bin/env bash
source "$( dirname "${BASH_SOURCE[0]}" )/_lib.sh"
$COMPOSE down
$COMPOSE up -d --build
