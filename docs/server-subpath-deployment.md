# Deploy QuantPilot at `/smartstock`

This runbook keeps the existing site on ports 80/443 unchanged. QuantPilot runs as two host services, while TimescaleDB and Redis run in Docker and bind only to localhost.

## Runtime layout

| Component | Address | Manager |
| --- | --- | --- |
| Existing site | existing upstream | existing service |
| QuantPilot web | `127.0.0.1:3000` | systemd |
| QuantPilot market-data | `127.0.0.1:8000` | systemd |
| Generated previews | `127.0.0.1:4100-4999` | QuantPilot child processes |
| TimescaleDB | `127.0.0.1:5432` | Docker Compose |
| Redis | `127.0.0.1:6379` | Docker Compose |
| Public entry | `https://mantleofintelligence.com/smartstock` | Nginx |

`NEXT_PUBLIC_BASE_PATH` is a Next.js build-time setting. Changing `/smartstock` later requires a new build and matching Nginx location, but no source-code changes.

## 1. Update the checkout and create production configuration

Run as `ubuntu`:

```bash
cd /opt/quantpilot
git pull --ff-only
cp deploy/server/quantpilot.env.example .env.production
chmod 600 .env.production
openssl rand -hex 32
openssl rand -hex 24
nano .env.production
```

Use the first generated value for `ENCRYPTION_KEY`. Use the second value in both `POSTGRES_PASSWORD` and the password portion of `DATABASE_URL`. Add only the AI provider credentials you actually use. Never commit `.env.production`.

## 2. Install dependencies without rewriting local development env files

```bash
cd /opt/quantpilot
QUANTPILOT_DEPLOYMENT=server npm ci
npx prisma generate

cd /opt/quantpilot/services/market-data
uv sync --frozen
cd /opt/quantpilot
```

## 3. Start localhost-only infrastructure and initialize the database

```bash
cd /opt/quantpilot
docker compose \
  --env-file .env.production \
  -f docker-compose.yml \
  -f deploy/server/docker-compose.server.yml \
  up -d timescaledb redis

docker compose \
  --env-file .env.production \
  -f docker-compose.yml \
  -f deploy/server/docker-compose.server.yml \
  ps

set -a
. ./.env.production
set +a
npm run db:init
```

Both containers must show `healthy`. The server override prevents ports 5432 and 6379 from being exposed publicly.

## 4. Build the subpath version

```bash
cd /opt/quantpilot
npm run build:server
```

The build command loads `.env.production` with override precedence, so the development `.env.local` created by older installs cannot replace `/smartstock` with localhost settings.

## 5. Install and start systemd services

```bash
cd /opt/quantpilot
sudo cp deploy/server/systemd/quantpilot-market-data.service /etc/systemd/system/
sudo cp deploy/server/systemd/quantpilot-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now quantpilot-market-data quantpilot-web

sudo systemctl --no-pager --full status quantpilot-market-data quantpilot-web
curl -fsS http://127.0.0.1:8000/health
curl -I http://127.0.0.1:3000/smartstock
```

The market-data health call must return JSON and the web request must return an HTTP success or redirect response.

## 6. Add the Nginx route to the existing domain

Create HTTP Basic Authentication before enabling the location. This application does not currently provide its own login boundary.

```bash
sudo apt-get update
sudo apt-get install -y apache2-utils
sudo htpasswd -c /etc/nginx/.quantpilot-htpasswd quantpilot

cd /opt/quantpilot
sudo cp deploy/server/nginx/quantpilot-websocket-map.conf /etc/nginx/conf.d/
sudo cp deploy/server/nginx/smartstock-proxy.conf /etc/nginx/snippets/quantpilot-smartstock-proxy.conf
sudo cp deploy/server/nginx/smartstock-location.conf /etc/nginx/snippets/quantpilot-smartstock.conf
```

Open the existing Nginx `server` block whose `server_name` contains `mantleofintelligence.com` and add this one line inside that block:

```nginx
include /etc/nginx/snippets/quantpilot-smartstock.conf;
```

Then validate and reload without restarting the existing application:

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -I -u quantpilot 'https://mantleofintelligence.com/smartstock'
```

Enter the Basic Auth password when prompted. Also open the URL in a browser and verify that the home page loads, a platform API request succeeds, and the browser console has no failed `/api`, `/_next`, SSE, or WebSocket requests.

Generated project previews use URLs such as `https://mantleofintelligence.com/smartstock/previews/4100`. Keep 4100-4999 closed in UFW; Nginx maps only that configured pool to localhost and protects it with the same Basic Auth realm. If the preview port range or `/smartstock` changes, update `.env.production`, `smartstock-location.conf`, and the port/path expression in `quantpilot-websocket-map.conf` together.

## Updating later

```bash
cd /opt/quantpilot
git pull --ff-only
QUANTPILOT_DEPLOYMENT=server npm ci

cd /opt/quantpilot/services/market-data
uv sync --frozen --extra baostock --extra akshare
cd /opt/quantpilot

npm run db:init
npm run build:server
sudo systemctl restart quantpilot-market-data quantpilot-web
sudo systemctl --no-pager --full status quantpilot-market-data quantpilot-web
curl -I http://127.0.0.1:3000/smartstock
```

Do not run `docker compose down -v` during updates; `-v` removes database volumes.

The tiered daily/active/minute refresh timers are installed separately. After upgrading to
the tiered strategy-data release, follow [tiered-market-data-deployment.md](./tiered-market-data-deployment.md)
to install or refresh those systemd units.
