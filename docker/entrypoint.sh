#!/bin/sh
# Runs as root only long enough to make /data writable, then drops to the
# unprivileged "yabbe" user. PUID/PGID let bind-mounted folders keep the host
# user's ownership (e.g. -e PUID=$(id -u) -e PGID=$(id -g)).
set -e

DATA="${YABBE_DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  if [ "${PGID}" != "$(id -g yabbe)" ]; then groupmod -o -g "${PGID}" yabbe; fi
  if [ "${PUID}" != "$(id -u yabbe)" ]; then usermod -o -u "${PUID}" yabbe; fi
  mkdir -p "$DATA"
  # Only walk the tree when ownership is actually wrong (fast on restarts).
  if [ "$(stat -c %u:%g "$DATA")" != "${PUID}:${PGID}" ]; then
    echo "yabbe: fixing ownership of $DATA for ${PUID}:${PGID}"
    chown -R "${PUID}:${PGID}" "$DATA"
  fi
  # setpriv keeps root's environment; give the app user a HOME it can read.
  export HOME=/tmp
  exec setpriv --reuid="${PUID}" --regid="${PGID}" --init-groups "$@"
fi

exec "$@"
