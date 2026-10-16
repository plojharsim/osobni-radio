# Osobní rádio

Osobní webové rádio, které hraje hudbu podle tvého vkusu.
Výběr skladeb bere z **[ListenBrainz](https://listenbrainz.org)** (doporučení, oblíbené, podobní interpreti), zvuk z **[yt-dlp](https://github.com/yt-dlp/yt-dlp)**.
Mezi skladbami občas promluví **AI moderátor** (hlášky, zprávy, počasí). Bez npm závislostí – stačí Node.js ≥ 20, yt-dlp a ffmpeg.

## Funkce
- **Nálady:** výběr hudby podle nálady (nabuzení, relax, veselé, smutné, na probuzení, ráno, odpoledne, večer, noc, soustředění, párty, sport) nebo automaticky podle denní doby. Vlastní skladby se filtrují podle tagů z ListenBrainz, zbytek doplňuje tag rádio.
- **Hudba podle vkusu:** mix doporučení z ListenBrainz, tvých nejposlouchanějších skladeb, podobných interpretů a skladeb s ♥. Ochrana proti opakování skladeb i interpretů.
- **Přehrávač:** minimalistický, s rozostřeným pozadím z obálky, klávesovými zkratkami, ovládáním ze zamčené obrazovky a režimem celé obrazovky.
- **Normalizace hlasitosti** (ffmpeg + Web Audio) a posuvník hlasitosti.
- **Texty písní** z [LRCLIB](https://lrclib.net) s karaoke zvýrazněním po slovech a ručním posunem časování (pamatuje se pro každou skladbu).
- **ListenBrainz zpětně:** s tokenem odesílá poslechy (scrobble) a hodnocení „líbí / nelíbí“.
- **AI moderátor:** text přes [OpenRouter](https://openrouter.ai) (zdarma dostupný model, při selhání záložní `openrouter/free`), hlas neurální (edge-tts). Hlášky, zprávy (ČT24 / BBC) a počasí ([Open-Meteo](https://open-meteo.com)), nastavitelná četnost 15–100 %.
- **Mobil:** responzivní rozložení, přetahování po liště postupu prstem, ovládání ze zamčené obrazovky; lze nainstalovat jako aplikaci (PWA): Chrome / Edge / Safari přes „Přidat na plochu“, Firefox pro Android přes menu → „Nainstalovat“. Firefox na počítači instalaci webových aplikací nepodporuje. Vyžaduje HTTPS (Cloudflare Tunnel ho zajišťuje).

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

**Ovládání:** mezerník = přehrát/pauza · → = další · L = líbí · D = nechci to slyšet · F = celá obrazovka · ↑/↓ = hlasitost

## Nastavení (`.env`)
Zkopíruj `.env.example` na `.env`. Důležité: `APP_PASSWORD` (heslo k celé aplikaci, zadává se na přihlašovací stránce, jen heslo – nastav ho, jakmile je dostupná z internetu), `PORT`, `HOST`, `OPENROUTER_API_KEY`, `LB_USER`, `LB_TOKEN`. Nastavení z aplikace se ukládá do `data/`.

## Nasazení na Ubuntu server

Návod pro server s Ubuntu 22.04 / 24.04 a veřejným přístupem přes **Cloudflare Tunnel**, který běží na jiném stroji než aplikace (veřejné jméno se nastavuje v Cloudflare dashboardu). Vše na serveru spouštěj přes SSH.

### 1. Instalace aplikace
```bash
sudo apt update && sudo apt install -y git
sudo git clone https://github.com/plojharsim/osobni-radio.git /opt/radio
cd /opt/radio && sudo ./deploy/install.sh
```
Skript nainstaluje Node.js, ffmpeg, yt-dlp a edge-tts, vytvoří uživatele `radio`, systemd službu `radio` (startuje sama po restartu) a týdenní aktualizaci yt-dlp.

### 2. Nastavení v `.env`
```bash
sudo nano /opt/radio/.env
```
```ini
HOST=0.0.0.0
APP_PASSWORD=tvoje-dlouhe-heslo
```
- `HOST=0.0.0.0` je nutné, protože tunnel běží na jiném stroji a musí se k aplikaci připojit po síti. (Když `cloudflared` běží na stejném serveru, nech `HOST=127.0.0.1`.)
- `APP_PASSWORD` je heslo k celé aplikaci. Na přihlašovací stránce se zadává jen heslo (bez jména). Použij dlouhé a unikátní. Nesmí obsahovat mezery na začátku/konci.
- Volitelně `OPENROUTER_API_KEY` (jde zadat i v nastavení aplikace).

Restartuj službu:
```bash
sudo systemctl restart radio
```

### 3. Firewall: port jen pro tunnel
Port 8787 povol **jen** pro IP adresu stroje, na kterém běží `cloudflared` (za `<IP-cloudflared>` dosaď tu adresu):
```bash
sudo ufw allow from <IP-cloudflared> to any port 8787 proto tcp
```
Port 8787 nikdy neotvírej do celého internetu. Spojení mezi tunnelem a serverem není šifrované, chrání ho jen tenhle firewall.

### 4. Veřejné jméno v Cloudflare dashboardu
Zero Trust → Networks → Tunnels → tvůj tunnel → *Public Hostname* → *Add a public hostname*:

| Pole | Hodnota |
|---|---|
| Subdomain / Domain | např. `radio.tvoje-domena.cz` |
| Type | `HTTP` |
| URL | `<IP-serveru>:8787` (např. `192.168.1.20:8787`) |

`<IP-serveru>` je adresa serveru, na kterém běží aplikace, tak jak je vidět ze stroje s tunnelem (typicky privátní IP v lokální síti).

### 5. První spuštění
Otevři `https://radio.tvoje-domena.cz`, zadej heslo a v nastavení aplikace (ozubené kolo) vyplň ListenBrainz uživatele a token, případně OpenRouter klíč a město pro počasí. Nastavení se ukládá do `/opt/radio/data` na serveru.

Při problémech: `sudo systemctl status radio` a `sudo journalctl -u radio -f`.

### Alternativy
- **Reverzní proxy na stejném serveru (Caddy):** nech `HOST=127.0.0.1`, nainstaluj `caddy` a do `/etc/caddy/Caddyfile` dej `radio.tvoje-domena.cz { reverse_proxy 127.0.0.1:8787 }`.
- **Docker:** `docker compose up -d` (data v kontejnerovém svazku).

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
