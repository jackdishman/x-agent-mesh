#!/bin/sh
# Runs the CMD as the non-root `node` user. If started as root (the default, e.g. on Fly), first
# makes the mounted /data volume writable by `node`: volumes are mounted owned by root.
set -e
if [ "$(id -u)" = "0" ]; then
  chown node:node /data
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
