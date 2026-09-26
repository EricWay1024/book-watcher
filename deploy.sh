#!/usr/bin/env bash
# Deploy to a server over ssh: sync the code, then install + restart there. Library data is left alone.
#   HOST=myserver DOMAIN=books.example.com ./deploy.sh
# HOST and DOMAIN can also live in a git-ignored ./deploy.local (sourced below).
set -euo pipefail
cd "$(dirname "$0")"
[ -f deploy.local ] && . ./deploy.local
: "${HOST:?set HOST (an ssh host) or put it in deploy.local}"
: "${DOMAIN:?set DOMAIN or put it in deploy.local}"
rsync -az --delete --exclude .venv --exclude data --exclude .git --exclude '__pycache__' --exclude deploy.local ./ "$HOST":book-watcher/
ssh "$HOST" "sudo bash book-watcher/deploy/install.sh $DOMAIN"
