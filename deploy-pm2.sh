#!/bin/sh
set -eu

cd /root/newapi-monitor
git pull --ff-only origin agent/focused-alerts
PATH=/opt/node/bin:$PATH npm ci --omit=dev
PATH=/opt/node/bin:$PATH npm test
PATH=/opt/node/bin:$PATH pm2 startOrReload ecosystem.config.cjs --update-env
PATH=/opt/node/bin:$PATH pm2 save
for _ in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS http://127.0.0.1:3456/healthz && exit 0
  sleep 1
done
exit 1
