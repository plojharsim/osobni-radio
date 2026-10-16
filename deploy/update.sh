#!/usr/bin/env bash
# Aktualizace nasazené aplikace:  sudo ./deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
[ -f package-lock.json ] && npm ci --omit=dev || true   # aplikace nemá závislosti, pro případ budoucích
/usr/local/bin/yt-dlp -U || true
[ -x .venv/bin/pip ] || python3 -m venv .venv
.venv/bin/pip install -q --upgrade edge-tts || true   # Microsoft občas mění protokol, nová verze to dožene
systemctl restart radio
sleep 1
curl -fsS http://127.0.0.1:${PORT:-8787}/api/health >/dev/null && echo "OK: aplikace běží" || { echo "Služba neodpovídá, viz: journalctl -u radio -e"; exit 1; }
