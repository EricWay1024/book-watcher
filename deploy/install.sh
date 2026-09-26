#!/usr/bin/env bash
# Runs ON the server as root (deploy.sh calls it). Installs/updates code, service and nginx site.
# Never touches the library data (/var/lib/book-watcher) or an existing /etc/book-watcher.env.
set -euo pipefail
DOMAIN=${1:?usage: install.sh DOMAIN}
SRC=$(cd "$(dirname "$0")/.." && pwd)
APP=/opt/book-watcher

id bookwatcher >/dev/null 2>&1 || useradd --system --home-dir /var/lib/book-watcher --shell /usr/sbin/nologin bookwatcher

mkdir -p "$APP"
rsync -a --delete --exclude .venv "$SRC"/ "$APP"/
[ -x "$APP/.venv/bin/python" ] || python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install -q --upgrade pip
"$APP/.venv/bin/pip" install -q --force-reinstall --no-deps "$APP" && "$APP/.venv/bin/pip" install -q "$APP"

if [ ! -f /etc/book-watcher.env ]; then
    pw=$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')
    umask 077
    printf 'BW_PASSWORD=%s\nBW_TTS_CACHE_MB=800\n' "$pw" > /etc/book-watcher.env
    echo "NEW PASSWORD: $pw"
fi

install -m 644 "$APP/deploy/book-watcher.service" /etc/systemd/system/book-watcher.service
systemctl daemon-reload
systemctl enable -q book-watcher
systemctl restart book-watcher

site=/etc/nginx/sites-available/$DOMAIN.conf
if [ ! -f "$site" ]; then
    sed "s/__DOMAIN__/$DOMAIN/" "$APP/deploy/nginx.conf" > "$site"
    ln -sf "$site" /etc/nginx/sites-enabled/
    nginx -t && systemctl reload nginx
    echo "nginx site created: $site (run certbot --nginx -d $DOMAIN once DNS points here)"
fi

sleep 2
systemctl is-active book-watcher
