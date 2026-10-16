#!/usr/bin/env bash
# Aktualizace nasazené aplikace:  sudo ./deploy/update.sh
set -euo pipefail

# Celé tělo je ve funkci: git pull může tenhle soubor přepsat a bash by jinak četl napůl novou verzi.
main() {
  cd "$(dirname "$0")/.."
  git pull --ff-only
  [ -f package-lock.json ] && npm ci --omit=dev || true   # aplikace nemá závislosti, pro případ budoucích
  if [ -d bgutil-ytdlp-pot-provider ]; then
    ./deploy/install-potoken.sh --quiet || true            # yt-dlp i plugin PO tokenu z .venv + případná přestavba pomocného serveru
  else
    /usr/local/bin/yt-dlp -U || true
  fi
  [ -x .venv/bin/pip ] || python3 -m venv .venv
  .venv/bin/pip install -q --upgrade edge-tts || true     # Microsoft občas mění protokol, nová verze to dožene
  systemctl restart radio

  local port host
  port=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2 | grep . || echo 8787)
  host=$(grep -E '^HOST=' .env 2>/dev/null | cut -d= -f2 | grep . || echo 127.0.0.1)
  [ "$host" = "0.0.0.0" ] && host=127.0.0.1
  # čekáme, až služba naběhne (200 = běží; 401 = běží a chce heslo)
  for _ in $(seq 1 15); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://$host:$port/api/health" || true)
    if [ "$code" = 200 ] || [ "$code" = 401 ]; then
      echo "OK: aplikace běží, verze $(grep -m1 '"version"' package.json | sed 's/[^0-9.]//g')"
      return 0
    fi
    sleep 1
  done
  echo "Služba neodpovídá, viz: journalctl -u radio -e"
  return 1
}
main "$@"; exit $?
