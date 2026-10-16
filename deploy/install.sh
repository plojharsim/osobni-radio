#!/usr/bin/env bash
# Jednorázová instalace na Ubuntu server (spusť jako root / přes sudo).
# Použití:  sudo ./deploy/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="${APP_USER:-radio}"
[ "$(id -u)" = 0 ] || { echo "Spusť přes sudo."; exit 1; }

echo "==> Závislosti (Node.js 22, ffmpeg, python3, curl)"
apt-get update -qq
apt-get install -y -qq curl ca-certificates ffmpeg python3 python3-venv git
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

echo "==> yt-dlp (oficiální binárka, aktualizovatelná přes 'yt-dlp -U')"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod a+rx /usr/local/bin/yt-dlp

echo "==> edge-tts (neurální hlas pro AI moderátora) do $APP_DIR/.venv"
python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -q --upgrade pip edge-tts

echo "==> Uživatel a práva"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/data"
[ -f "$APP_DIR/.env" ] || cp "$APP_DIR/.env.example" "$APP_DIR/.env"
chown -R "$APP_USER": "$APP_DIR/data"
chmod 640 "$APP_DIR/.env"; chown root:"$APP_USER" "$APP_DIR/.env"

echo "==> systemd služba"
sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__APP_USER__#$APP_USER#g" "$APP_DIR/deploy/radio.service" > /etc/systemd/system/radio.service
systemctl daemon-reload
systemctl enable --now radio
# týdenní aktualizace yt-dlp (YouTube často mění věci)
cat > /etc/systemd/system/radio-ytdlp-update.service <<UNIT
[Unit]
Description=Aktualizace yt-dlp
[Service]
Type=oneshot
ExecStart=/usr/local/bin/yt-dlp -U
ExecStartPost=$APP_DIR/.venv/bin/pip install -q --upgrade edge-tts
UNIT
cat > /etc/systemd/system/radio-ytdlp-update.timer <<UNIT
[Unit]
Description=Týdenní aktualizace yt-dlp
[Timer]
OnCalendar=weekly
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now radio-ytdlp-update.timer

cat <<MSG

Hotovo. Aplikace běží na http://127.0.0.1:8787 (jen lokálně).
Dál:
  1) Nastav heslo:   sudo nano $APP_DIR/.env   (APP_PASSWORD=...)  a  sudo systemctl restart radio
  2) Zpřístupni ven přes reverzní proxy s HTTPS, např. Caddy:
       sudo apt install caddy
       echo 'radio.example.com { reverse_proxy 127.0.0.1:8787 }' | sudo tee /etc/caddy/Caddyfile
       sudo systemctl reload caddy
  3) Aktualizace aplikace později:  sudo ./deploy/update.sh
MSG
