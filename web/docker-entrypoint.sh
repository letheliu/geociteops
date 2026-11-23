#!/bin/sh
# Render nginx.conf from the template, then hand off to the image entrypoint.
# Only two placeholders are replaced, so nginx variables ($host, $uri, …) stay.
set -eu

UPSTREAM="${GEO_API_UPSTREAM:-app:4000}"
LISTEN_PORT="${PORT:-80}"

case "$UPSTREAM" in
  *[!A-Za-z0-9._:-]*)
    echo "[web] GEO_API_UPSTREAM must be a host:port (got a disallowed character)" >&2
    exit 1
    ;;
esac

case "$LISTEN_PORT" in
  ''|*[!0-9]*)
    echo "[web] PORT must be a number" >&2
    exit 1
    ;;
esac

if [ "$LISTEN_PORT" -lt 1 ] || [ "$LISTEN_PORT" -gt 65535 ]; then
  echo "[web] PORT out of range" >&2
  exit 1
fi

sed \
  -e "s|__GEO_API_UPSTREAM__|${UPSTREAM}|g" \
  -e "s|__LISTEN_PORT__|${LISTEN_PORT}|g" \
  /etc/nginx/default.conf.template > /etc/nginx/conf.d/default.conf

exec /docker-entrypoint.sh "$@"
