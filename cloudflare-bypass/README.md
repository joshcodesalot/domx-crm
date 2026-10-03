# Cloudflare bypass — install on the Debian server

This folder is the DomX copy of CloudflareBypassForScraping. A hung browser close kills the Playwright driver instead of leaving it running. DomX already calls it at `http://127.0.0.1:8000`. You do not restart DomX after this.

On your PC, zip the whole `cloudflare-bypass` folder into one file, `cloudflare-bypass.zip`, and upload that file to the server (for example into `/home/debian`).

Then, on the server:

## 1. Unzip

```bash
cd /home/debian
unzip cloudflare-bypass.zip
cd cloudflare-bypass
```

You should see `Dockerfile` and `docker-compose.yml` in this directory. If unzip created an extra folder, `cd` into the directory that contains those two files.

## 2. Remove the old container

The old container is the one leaking Playwright drivers. Remove it before the new build starts.

```bash
docker rm -f cloudflare-bypass
```

If Docker says the container does not exist, continue.

## 3. Build and start

The first build downloads Ubuntu packages, Python libraries, and the CloakBrowser binary. It takes several minutes.

```bash
docker compose up -d --build
```

If that command is not found:

```bash
docker-compose up -d --build
```

The container listens on `127.0.0.1:8000` only, allows 2 GB of shared memory, and stops at 4 GB of RAM.

## 4. Check that it is running

```bash
docker ps --filter name=cloudflare-bypass
docker logs --tail 30 cloudflare-bypass
```

`docker ps` should show `cloudflare-bypass` with status `Up`. The log should show the server listening on port 8000.

## 5. Confirm the old drivers are gone

```bash
ps -eo rss,cmd | awk '/playwright\/driver\/node/ && /run-driver/ {n++; rss+=$1} END {print n+0 " drivers,", rss/1024/1024 " GB"}'
```

Right after the new container starts, this should be `0 drivers` or a small number, not hundreds. Check again after the Maloum models have been in use for a day. It should stay in the single digits.
