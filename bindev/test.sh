#!/usr/bin/env bash
# pytest im Backend-Container ausführen.
# Tests laufen gegen ein separates Schema `mynotes_test`. Wir legen es
# bei jedem Lauf neu an und lassen alembic upgrade dagegen laufen.
source "$( dirname "${BASH_SOURCE[0]}" )/_lib.sh"

echo "→ Test-DB neu anlegen"
$COMPOSE exec -T db sh -c '
  mariadb -uroot -proot -e "
    DROP DATABASE IF EXISTS mynotes_test;
    CREATE DATABASE mynotes_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    GRANT ALL PRIVILEGES ON mynotes_test.* TO '"'"'app'"'"'@'"'"'%'"'"';
    FLUSH PRIVILEGES;
  "
'

echo "→ Schema-Migration auf Test-DB"
$COMPOSE exec -T \
  -e DB_URL="mysql+asyncmy://app:app@db:3306/mynotes_test" \
  backend alembic upgrade head

echo "→ Tests"
$COMPOSE exec -T \
  -e DB_URL="mysql+asyncmy://app:app@db:3306/mynotes_test" \
  -e JWT_SECRET="test-secret" \
  -e MASTER_KEY_B64="" \
  -e BOOTSTRAP_ADMIN_EMAIL="admin@test.com" \
  -e BOOTSTRAP_ADMIN_PASSWORD="test123" \
  -e ASSET_DIR="/tmp/mynotes-test-assets" \
  backend pytest "$@"
