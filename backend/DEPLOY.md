# DomX Backend — Debian Production Hosting

Deploy the DomX Express API on a Debian server at **https://api.low7labs.cloud**, listening on port **4001** behind nginx with TLS.

## Overview

| Item | Value |
| --- | --- |
| Domain | `api.low7labs.cloud` |
| App directory | `/home/debian/domx_backend` |
| App port | `4001` (local only; nginx handles 443) |
| Runtime | Node.js 20 LTS |
| Process manager | `screen` |
| Database | PostgreSQL |
| TLS | Let's Encrypt (Certbot) |

There is no build step — the backend is plain JavaScript and runs `node src/index.js` directly. You do **not** run `yarn build` or copy a compiled output folder.

All commands below assume you are logged in as **root** on the server.

---

## Quick deploy (copy from your machine)

This is the simplest workflow: copy source from your dev machine, install dependencies **on the server**, migrate, and start with screen.

### On your local machine — copy these files

From the `backend/` folder, copy to `/home/debian/domx_backend` on the server:

| Copy | Required |
| --- | --- |
| `package.json` | Yes |
| `package-lock.json` or `yarn.lock` | Yes |
| `src/` (entire folder) | Yes |
| `.env` (production values) | Yes |
| `data/avatars/` | Optional — can create empty on server |

**Do not copy:**
- `node_modules/` — must be installed on the server (native deps are OS-specific)
- Any `dist/` or build output — the backend has none

Example using rsync/scp:

```bash
# From your project root on your local machine
rsync -av --exclude node_modules backend/package.json backend/package-lock.json backend/src root@your-server:/home/debian/domx_backend/

# Copy your production .env separately (do not commit secrets to git)
scp backend/.env root@your-server:/home/debian/domx_backend/.env
```

### On the server — install, migrate, start

```bash
mkdir -p /home/debian/domx_backend/data/avatars
cd /home/debian/domx_backend

yarn install                # or: npm ci

yarn migrate                # or: npm run migrate
yarn seed                   # first time only — or: npm run seed

screen -S domx-api -dm bash -c 'node src/index.js'
curl http://127.0.0.1:4001/api/health
```

After nginx and TLS are set up (sections 8–9), verify:

```bash
curl https://api.low7labs.cloud/api/health
```

---

## Prerequisites

- Debian server with root access
- DNS `A` (and optionally `AAAA`) record for `api.low7labs.cloud` pointing at the server
- Firewall allows inbound **80** and **443**

---

## 1. Install system packages

```bash
apt update
apt install -y curl gnupg ca-certificates lsb-release nginx postgresql postgresql-contrib certbot python3-certbot-nginx git screen
```

### Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v   # should be v20.x
```

---

## 2. App directory (alternative: git clone)

If you prefer git on the server instead of copying from your machine:

```bash
mkdir -p /home/debian/domx_backend
git clone <your-repo-url> /home/debian/domx_repo
cp -r /home/debian/domx_repo/backend/* /home/debian/domx_backend/
cp /home/debian/domx_backend/.env.example /home/debian/domx_backend/.env
nano /home/debian/domx_backend/.env
```

Then continue from section 3 below.

---

## 3. Install Node dependencies

```bash
cd /home/debian/domx_backend
yarn install                # or: npm ci
```

Ensure the avatar upload directory exists:

```bash
mkdir -p /home/debian/domx_backend/data/avatars
```

---

## 4. PostgreSQL setup

Set a password for the default `postgres` user, then create the database:

```bash
sudo -u postgres psql
```

In the `psql` shell:

```sql
ALTER USER postgres WITH PASSWORD 'STRONG_PASSWORD_HERE';
CREATE DATABASE domx;
\q
```

---

## 5. Production environment file

Create `/home/debian/domx_backend/.env`:

```bash
cp /home/debian/domx_backend/.env.example /home/debian/domx_backend/.env
nano /home/debian/domx_backend/.env
```

Example production values:

```env
PORT=4001
DATABASE_URL=postgresql://postgres:STRONG_PASSWORD_HERE@127.0.0.1:5432/domx
JWT_SECRET=generate-a-long-random-string
CORS_ORIGIN=https://domx.low7labs.cloud
ENCRYPTION_KEY=base64-encoded-32-byte-key
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
chmod 600 /home/debian/domx_backend/.env
```

### Notes

- **`CORS_ORIGIN`**: Set to your actual client origin(s). Avoid `*` in production — the API uses `credentials: true`, which does not work reliably with a wildcard origin in browsers.
- **`DOMX_ELECTRON_SERVICE_KEY`**: Must match the same value in the Electron app's environment (`frontend/.env` / build config).
- **Client API URL**: Point desktop builds at `https://api.low7labs.cloud` via `VITE_API_URL` and `DOMX_API_URL`.

---

## 6. Migrate and seed the database

```bash
cd /home/debian/domx_backend
yarn migrate                # or: npm run migrate
yarn seed                   # first time only — or: npm run seed
```

`seed` creates roles and permissions. The owner account is created on first app launch.

---

## 7. Run the API with screen

Start the API in a detached screen session named `domx-api`:

```bash
cd /home/debian/domx_backend
screen -S domx-api -dm bash -c 'node src/index.js'
```

Verify it is running:

```bash
curl http://127.0.0.1:4001/api/health
# {"status":"ok","database":"connected"}
```

### Screen commands

| Task | Command |
| --- | --- |
| List sessions | `screen -ls` |
| Attach (view logs) | `screen -r domx-api` |
| Detach (leave running) | `Ctrl+A` then `D` |
| Stop the API | Attach, then `Ctrl+C` |
| Start again | `screen -S domx-api -dm bash -c 'node src/index.js'` |

To restart after a code or `.env` change:

```bash
screen -S domx-api -X quit
cd /home/debian/domx_backend
screen -S domx-api -dm bash -c 'node src/index.js'
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
ln -s /etc/nginx/sites-available/api.low7labs.cloud /etc/nginx/sites-enabled/
nginx -t
nginx -s reload
```

The app sets `trust proxy` and sends `X-Accel-Buffering: no` on SSE responses, so nginx will not buffer event streams.

---

## 9. TLS with Let's Encrypt

```bash
certbot --nginx -d api.low7labs.cloud
```

Certbot updates the nginx config for HTTPS and sets up auto-renewal. Test renewal:

```bash
certbot renew --dry-run
```

Verify over HTTPS:

```bash
curl https://api.low7labs.cloud/api/health
```

---

## 10. Firewall (optional)

If using `ufw`:

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

Port **4001** does not need to be exposed publicly — nginx proxies to it on localhost.

---

## Updating the deployment

After copying new backend files from your machine (or `git pull` if using git on the server):

```bash
cd /home/debian/domx_backend
yarn install                # or: npm ci — if package.json changed
yarn migrate                # or: npm run migrate — if new migrations exist
screen -S domx-api -X quit
screen -S domx-api -dm bash -c 'node src/index.js'
```

---

## Operations cheatsheet

| Task | Command |
| --- | --- |
| Start API | `screen -S domx-api -dm bash -c 'node src/index.js'` (from app dir) |
| Stop API | `screen -S domx-api -X quit` |
| View live output | `screen -r domx-api` |
| List screen sessions | `screen -ls` |
| Health check | `curl https://api.low7labs.cloud/api/health` |
| Reload nginx | `nginx -t && nginx -s reload` |

---

## Troubleshooting

**502 Bad Gateway**
- Check the screen session exists: `screen -ls`
- Confirm port: `curl http://127.0.0.1:4001/api/health`
- Attach and check for errors: `screen -r domx-api`

**Database connection errors**
- Check Postgres is accepting connections: `pg_isready`
- Test credentials: `psql "$DATABASE_URL" -c 'SELECT 1'`

**SSE / live events disconnect**
- Confirm nginx has `proxy_buffering off` and long `proxy_read_timeout`
- Check that Certbot did not overwrite SSE-related settings in the nginx config

**CORS errors in browser**
- Set `CORS_ORIGIN` to the exact client origin (scheme + host, no trailing slash)
- Restart the API in screen after changing `.env`

**API not running after server reboot**
- Screen sessions do not survive reboots. Re-run:
  ```bash
  cd /home/debian/domx_backend
  screen -S domx-api -dm bash -c 'node src/index.js'
  ```
