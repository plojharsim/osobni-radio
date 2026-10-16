#!/usr/bin/env bash
# Volitelné: ochrana proti YouTube „ověřte, že nejste robot“ BEZ přihlášení (PO token).
#   sudo ./deploy/install-potoken.sh            instalace (a také aktualizace, je idempotentní)
#
# Co to udělá:
#   1) nainstaluje yt-dlp a plugin bgutil-ytdlp-pot-provider do .venv aplikace (pip)
#   2) stáhne a sestaví pomocný server (stejná verze jako plugin) do <app>/bgutil-ytdlp-pot-provider
#   3) vytvoří systemd službu radio-pot (server poslouchá jen na 127.0.0.1:4416)
#   4) nastaví YTDLP_BIN v .env na yt-dlp z .venv a restartuje aplikaci
# Pomocný server je jen zrychlení: plugin umí i bez něj spustit skript přímo ze složky v domovském adresáři služby.
set -euo pipefail

QUIET=0; [ "${1:-}" = "--quiet" ] && QUIET=1
say() { [ "$QUIET" = 1 ] || echo "$@"; }

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="${APP_USER:-radio}"
VENV="$APP_DIR/.venv"
SRV="$APP_DIR/bgutil-ytdlp-pot-provider"      # domovský adresář uživatele radio = $APP_DIR, tam plugin hledá skript sám
[ "$(id -u)" = 0 ] || { echo "Spusť přes sudo."; exit 1; }
command -v node >/dev/null || { echo "Chybí Node.js (spusť nejdřív deploy/install.sh)."; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "Pomocný server vyžaduje Node.js >= 22 (máš $(node -v))."; exit 1; }

say "==> yt-dlp a plugin v $VENV"
command -v git >/dev/null || apt-get install -y -qq git
[ -x "$VENV/bin/pip" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install -q -U pip "yt-dlp[default]" bgutil-ytdlp-pot-provider
VER="$("$VENV/bin/pip" show bgutil-ytdlp-pot-provider | awk '/^Version:/{print $2}')"

if [ "$(cat "$SRV/.built-version" 2>/dev/null || true)" != "$VER" ]; then
  say "==> pomocný server $VER"
  rm -rf "$SRV"
  git clone -q --single-branch --branch "$VER" https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$SRV"
  (cd "$SRV/server" && npm ci --silent && npx tsc)
  echo "$VER" > "$SRV/.built-version"
  chown -R "$APP_USER": "$SRV"
fi

say "==> služba radio-pot"
cat > /etc/systemd/system/radio-pot.service <<UNIT
[Unit]
Description=Personal Radio - PO token provider pro yt-dlp
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$SRV/server
ExecStart=$(command -v node) build/main.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

# týdenní aktualizace: místo samotného yt-dlp -U aktualizuje yt-dlp i plugin a případně znovu sestaví server
mkdir -p /etc/systemd/system/radio-ytdlp-update.service.d
cat > /etc/systemd/system/radio-ytdlp-update.service.d/override.conf <<UNIT
[Service]
ExecStart=
ExecStart=$APP_DIR/deploy/install-potoken.sh --quiet
ExecStartPost=
ExecStartPost=$VENV/bin/pip install -q --upgrade edge-tts
UNIT
systemctl daemon-reload
systemctl enable --now radio-pot >/dev/null 2>&1 || true
systemctl restart radio-pot

say "==> .env: YTDLP_BIN=$VENV/bin/yt-dlp"
[ -f "$APP_DIR/.env" ] || cp "$APP_DIR/.env.example" "$APP_DIR/.env"
if grep -qE '^YTDLP_BIN=' "$APP_DIR/.env"; then sed -i "s#^YTDLP_BIN=.*#YTDLP_BIN=$VENV/bin/yt-dlp#" "$APP_DIR/.env"; else echo "YTDLP_BIN=$VENV/bin/yt-dlp" >> "$APP_DIR/.env"; fi
systemctl restart radio

if [ "$QUIET" = 0 ]; then
cat <<MSG

Hotovo. Ověření (mělo by vypsat „bgutil:http-$VER“ a nesmí tam být chyba bot kontroly):
  sudo -u $APP_USER $VENV/bin/yt-dlp -v --simulate -f bestaudio "https://www.youtube.com/watch?v=IuGO6WHcruU" 2>&1 | grep -i "pot\\|bgutil\\|ERROR"
Stav služby:  systemctl status radio-pot
MSG
fi
