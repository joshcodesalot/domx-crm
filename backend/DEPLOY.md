# DomX Backend — Debian Production Hosting

Deploy the DomX Express API on a Debian server at **https://api.low7labs.cloud**, listening on port **4001** behind nginx with TLS.

## Overview

| Item | Value |
| --- | --- |
| Domain | `api.low7labs.cloud` |
| App port | `4001` (local only; nginx handles 443) |
| Runtime | Node.js 20 LTS |
| Process manager | systemd |
| Database | PostgreSQL |
| TLS | Let's Encrypt (Certbot) |

There is no build step — the server runs `node src/index.js` directly.

---

## Prerequisites

- Debian server with sudo access
- DNS `A` (and optionally `AAAA`) record for `api.low7labs.cloud` pointing at the server
- Firewall allows inbound **80** and **443**

---

## 1. Install system packages

```bash
sudo apt update
sudo apt install -y curl gnupg ca-certificates lsb-release nginx postgresql postgresql-contrib certbot python3-certbot-nginx git
```

### Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # should be v20.x
```

---

## 2. Create a service user and app directory

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin domx
sudo mkdir -p /opt/domx
sudo chown domx:domx /opt/domx
```

Copy or clone the backend into `/opt/domx/backend`:

```bash
# Option A: git clone (adjust repo URL)
sudo -u domx git clone <your-repo-url> /opt/domx/repo
sudo -u domx cp -r /opt/domx/repo/backend /opt/domx/backend

# Option B: rsync/scp from your machine
# rsync -av backend/ user@server:/opt/domx/backend/
# sudo chown -R domx:domx /opt/domx/backend
```

---

## 3. Install Node dependencies and Playwright

```bash
cd /opt/domx/backend
sudo -u domx npm ci
sudo -u domx npx playwright install chromium
sudo npx playwright install-deps chromium
```

Playwright Chromium is required for creator account connect (Maloum login).

Ensure the avatar upload directory exists and is writable:

```bash
sudo -u domx mkdir -p /opt/domx/backend/data/avatars
```

---

## 4. PostgreSQL setup

```bash
sudo -u postgres psql
```

In the `psql` shell:

```sql
CREATE USER domx WITH PASSWORD 'STRONG_PASSWORD_HERE';
CREATE DATABASE domx OWNER domx;
\q
```

---

## 5. Production environment file

Create `/opt/domx/backend/.env`:

```bash
sudo -u domx cp /opt/domx/backend/.env.example /opt/domx/backend/.env
sudo -u domx nano /opt/domx/backend/.env
```

Example production values:

```env
PORT=4001
DATABASE_URL=postgresql://domx:STRONG_PASSWORD_HERE@127.0.0.1:5432/domx
JWT_SECRET=generate-a-long-random-string
CORS_ORIGIN=https://domx.low7labs.cloud
ENCRYPTION_KEY=base64-encoded-32-byte-key
PLAYWRIGHT_HEADLESS=true
XAI_API_KEY=your-xai-api-key
XAI_MODEL=grok-4.20-non-reasoning
DOMX_ELECTRON_SERVICE_KEY=generate-a-long-random-string
```

Generate secrets:

```bash
# 32-byte encryption key (base64)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Random JWT / service key
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Lock down permissions:

```bash
sudo chmod 600 /opt/domx/backend/.env
sudo chown domx:domx /opt/domx/backend/.env
```

### Notes

- **`CORS_ORIGIN`**: Set to your actual client origin(s). Avoid `*` in production — the API uses `credentials: true`, which does not work reliably with a wildcard origin in browsers.
- **`DOMX_ELECTRON_SERVICE_KEY`**: Must match the same value in the Electron app's environment (`frontend/.env` / build config).
- **Client API URL**: Point desktop builds at `https://api.low7labs.cloud` via `VITE_API_URL` and `DOMX_API_URL`.

---

## 6. Migrate and seed the database

```bash
cd /opt/domx/backend
sudo -u domx npm run migrate
sudo -u domx npm run seed
```

`seed` creates roles and permissions. The owner account is created on first app launch.

---

## 7. systemd service

Create `/etc/systemd/system/domx-api.service`:

```ini
[Unit]
Description=DomX API
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=domx
Group=domx
WorkingDirectory=/opt/domx/backend
EnvironmentFile=/opt/domx/backend/.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5

# Hardening (optional)
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable domx-api
sudo systemctl start domx-api
sudo systemctl status domx-api
```

Verify locally:

```bash
curl http://127.0.0.1:4001/api/health
# {"status":"ok","database":"connected"}
```

View logs:

```bash
journalctl -u domx-api -f
```

---

## 8. nginx reverse proxy

Create `/etc/nginx/sites-available/api.low7labs.cloud`:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name api.low7labs.cloud;

    location / {
        proxy_pass http://127.0.0.1:4001;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE (/api/events/stream) — long-lived connections
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;

        # Allow avatar uploads if needed
        client_max_body_size 10M;
    }
}
```

Enable the site and test:

```bash
sudo ln -s /etc/nginx/sites-available/api.low7labs.cloud /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

The app sets `trust proxy` and sends `X-Accel-Buffering: no` on SSE responses, so nginx will not buffer event streams.

---

## 9. TLS with Let's Encrypt

```bash
sudo certbot --nginx -d api.low7labs.cloud
```

Certbot updates the nginx config for HTTPS and sets up auto-renewal. Test renewal:

```bash
sudo certbot renew --dry-run
```

Verify over HTTPS:

```bash
curl https://api.low7labs.cloud/api/health
```

---

## 10. Firewall (optional)

If using `ufw`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Port **4001** does not need to be exposed publicly — nginx proxies to it on localhost.

---

## Updating the deployment

After pulling new backend code:

```bash
cd /opt/domx/backend
sudo -u domx git pull          # if deployed via git
sudo -u domx npm ci
sudo -u domx npm run migrate   # if new migrations exist
sudo systemctl restart domx-api
```

If Playwright was upgraded, reinstall Chromium:

```bash
cd /opt/domx/backend
sudo -u domx npx playwright install chromium
sudo npx playwright install-deps chromium
sudo systemctl restart domx-api
```

---

## Operations cheatsheet

| Task | Command |
| --- | --- |
| Start API | `sudo systemctl start domx-api` |
| Stop API | `sudo systemctl stop domx-api` |
| Restart API | `sudo systemctl restart domx-api` |
| Status | `sudo systemctl status domx-api` |
| Logs | `journalctl -u domx-api -f` |
| Health check | `curl https://api.low7labs.cloud/api/health` |
| Reload nginx | `sudo nginx -t && sudo systemctl reload nginx` |

---

## Troubleshooting

**502 Bad Gateway**
- Check the API is running: `systemctl status domx-api`
- Confirm port: `curl http://127.0.0.1:4001/api/health`
- Check logs: `journalctl -u domx-api -n 50`

**Database connection errors**
- Verify PostgreSQL is running: `sudo systemctl status postgresql`
- Test `DATABASE_URL` credentials: `psql "$DATABASE_URL" -c 'SELECT 1'`

**Playwright / creator connect fails**
- Re-run: `npx playwright install-deps chromium`
- Ensure `PLAYWRIGHT_HEADLESS=true` in `.env`

**SSE / live events disconnect**
- Confirm nginx has `proxy_buffering off` and long `proxy_read_timeout`
- Check that Certbot did not overwrite SSE-related settings in the nginx config

**CORS errors in browser**
- Set `CORS_ORIGIN` to the exact client origin (scheme + host, no trailing slash)
- Restart the API after changing `.env`
