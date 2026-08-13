# NewAPI Monitor Agent Guide

## Deployment

- Production host: `ssh hk-main`
- Production checkout: `/root/newapi-monitor`
- Branch: `agent/focused-alerts`
- Process manager: PM2 process `newapi-monitor`
- Do not build, pull, or run a Docker image for this application.
- This project has no frontend build step; static files are served directly from `public/`.

After each completed change:

1. Run `npm test` and `node --check server.js` locally.
2. Commit only the relevant files and push `agent/focused-alerts` to GitHub.
3. On the server run `cd /root/newapi-monitor && ./deploy-pm2.sh`.
4. Verify `pm2 status newapi-monitor`, `pm2 logs newapi-monitor --lines 30 --nostream`, and `curl -fsS http://127.0.0.1:3456/healthz`.

Never commit `.env`, database URLs, access tokens, dashboard keys, or notification credentials.
