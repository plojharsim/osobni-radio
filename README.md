# Osobní rádio

Osobní webové rádio, které hraje hudbu podle tvého vkusu.
Výběr skladeb bere z **[ListenBrainz](https://listenbrainz.org)** (doporučení, oblíbené, podobní interpreti), zvuk z **[yt-dlp](https://github.com/yt-dlp/yt-dlp)**.
Mezi skladbami občas promluví **AI moderátor** (hlášky, zprávy, počasí). Bez npm závislostí – stačí Node.js ≥ 20, yt-dlp a ffmpeg.

## Funkce
- **Hudba podle vkusu:** mix doporučení z ListenBrainz, tvých nejposlouchanějších skladeb, podobných interpretů a skladeb s ♥. Ochrana proti opakování skladeb i interpretů.
- **Přehrávač:** minimalistický, s rozostřeným pozadím z obálky, klávesovými zkratkami, ovládáním ze zamčené obrazovky a režimem celé obrazovky.
- **Normalizace hlasitosti** (ffmpeg + Web Audio) a posuvník hlasitosti.
- **Texty písní** z [LRCLIB](https://lrclib.net) s karaoke zvýrazněním po slovech.
- **ListenBrainz zpětně:** s tokenem odesílá poslechy (scrobble) a hodnocení „líbí / nelíbí“.
- **AI moderátor:** text přes [OpenRouter](https://openrouter.ai) (zdarma dostupný model), hlas neurální (edge-tts). Hlášky, zprávy (ČT24 / BBC) a počasí ([Open-Meteo](https://open-meteo.com)), nastavitelná četnost 15–100 %.
- **Debug menu** (klávesa `` ` ``).

## Rychlý start
Potřebuješ: Node.js ≥ 20, [yt-dlp](https://github.com/yt-dlp/yt-dlp), ffmpeg a pro moderátora python3.

```bash
git clone https://github.com/plojharsim/osobni-radio.git
cd osobni-radio
python3 -m venv .venv && .venv/bin/pip install edge-tts   # jen pro AI moderátora
node server.js                                            # http://127.0.0.1:8787
```
V aplikaci (ozubené kolo) zadej uživatelské jméno z ListenBrainz. User token ([nastavení účtu](https://listenbrainz.org/settings/)) je potřeba pro objevování podobných interpretů a synchronizaci poslechů.
Pro moderátora vlož klíč z [openrouter.ai/keys](https://openrouter.ai/keys).

**Ovládání:** mezerník = přehrát/pauza · → = další · L = líbí · D = nechci to slyšet · F = celá obrazovka · ↑/↓ = hlasitost · ` = debug

## Nastavení (`.env`)
Zkopíruj `.env.example` na `.env`. Důležité: `APP_PASSWORD` (heslo k celé aplikaci – nastav ho, jakmile je dostupná z internetu), `PORT`, `HOST`, `OPENROUTER_API_KEY`, `LB_USER`, `LB_TOKEN`. Nastavení z aplikace se ukládá do `data/`.

## Nasazení na Ubuntu server
```bash
git clone https://github.com/plojharsim/osobni-radio.git /opt/radio && cd /opt/radio
sudo ./deploy/install.sh     # Node, yt-dlp, ffmpeg, edge-tts, systemd služba, týdenní update yt-dlp
```
Pak nastav `APP_PASSWORD` v `.env` a před aplikaci dej HTTPS reverzní proxy (příklad s Caddy vypíše instalační skript).
Alternativa: `docker compose up -d` (data v kontejnerovém svazku).

## Aktualizace
```bash
sudo ./deploy/update.sh      # git pull + yt-dlp -U + edge-tts + restart + kontrola
```
Data (nastavení, historie, „líbí se“) jsou v `data/` a aktualizace je nemění.

## Poznámky
- Aplikace je určená pro **osobní použití**. Zvuk se přes server streamuje z YouTube; dodržuj podmínky služeb a zákony své země.
- Hlas moderátora používá neoficiální rozhraní Microsoft Edge (edge-tts). Může přestat fungovat, aktualizace edge-tts to obvykle opraví.
- AI modelu se do hlášek posílají jen názvy skladeb, čas a (u počasí a zpráv) veřejná data. ListenBrainz token ani klíče nikam dál neodcházejí.

## Licence
[MIT](LICENSE)
