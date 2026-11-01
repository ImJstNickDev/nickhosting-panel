#!/bin/sh
set -eu
# Only this one substitution is allowed. Never substitute Nginx's own $variables.
case "${NH_PUBLIC_URL:-}" in
  https://*) NH_PUBLIC_HOST=${NH_PUBLIC_URL#https://}; NH_PUBLIC_HOST=${NH_PUBLIC_HOST%/}; NH_PUBLIC_HOST=${NH_PUBLIC_HOST%:443} ;;
  *) echo 'HTTPS public origin required' >&2; exit 1 ;;
esac
NH_PUBLIC_HOST=$(printf '%s' "$NH_PUBLIC_HOST" | tr '[:upper:]' '[:lower:]')
case "$NH_PUBLIC_HOST" in
  ''|*[!a-z0-9.-]*|.*|*..*|*.) echo 'Invalid NH_PUBLIC_HOST' >&2; exit 1 ;;
esac
export NH_PUBLIC_HOST
envsubst '${NH_PUBLIC_HOST}' < /opt/nickhosting/nginx.conf.template > /tmp/nginx.conf
nginx -t -c /tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'
