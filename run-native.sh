#!/bin/sh
set -eu

NEWAPI_COMPOSE=/opt/1panel/docker/compose/newapi-2/docker-compose.yml
POSTGRES_CONTAINER=1Panel-postgresql-s00E

test -r "$NEWAPI_COMPOSE"
DATABASE_URL=$(sed -n 's/^[[:space:]]*- SQL_DSN=//p' "$NEWAPI_COMPOSE")
test -n "$DATABASE_URL"
NEWAPI_ACCESS_TOKEN=$(docker exec -e DATABASE_URL="$DATABASE_URL" "$POSTGRES_CONTAINER" \
  sh -c 'psql "$DATABASE_URL" -qAt -v ON_ERROR_STOP=1 -c "SELECT access_token FROM users WHERE id = 1"')

test -n "$NEWAPI_ACCESS_TOKEN"
export DATABASE_URL NEWAPI_ACCESS_TOKEN
export NEWAPI_BASE_URL=http://127.0.0.1:3000

exec /opt/node/bin/node server.js
