# Deployment on minipc

## Current release

The user asked to merge the logo change and update `tnfssc@minipc`. PR [#10](https://github.com/tnfssc/hoard.sharath.page/pull/10) merged into `develop` on 2026-10-04 at `d16e78a108d7ad6214458e3426579b0f6c6bf28f`. CI and Docker Build were green.

The live image is `hoard.sharath.page:logo-d16e78a`. Docker image ID: `sha256:27deba3728d97d0c18a3135633a4ee53723a12ceab29614d70159eef3c8e725e`. The image revision label is the merged commit. Build source is at `/home/tnfssc/Code/self-hosted/host/releases/d16e78a`, made with `git archive` of that commit.

## Service

Compose lives at `/home/tnfssc/Code/self-hosted/host/docker-compose.yml`. The service is `hoard`, container `host-hoard-1`, network `host_default`. The unchanged `host_data` volume is mounted at `/data`. Only the hoard image was changed. The existing .env and Cloudflare tunnel settings were kept. There is also an older `host-host-1` container; it was not removed.

SSH works with the current key. The remote login shell is fish. Use `bash -s` for shell scripts; plain `set -e` does not mean the same thing there. When feeding a script to SSH stdin, redirect `docker compose exec` stdin from `/dev/null` or it can consume the rest of the script.

## Checks

- `docker compose up -d --no-deps --wait --wait-timeout 120 hoard` completed. Container health is healthy.
- `docker exec host-hoard-1 /hoard healthcheck` passed.
- Public `https://hoard.sharath.page/healthz` and `/admin` returned 200.
- Both regular logo URLs and cache-busted URLs returned 200 and matched source SHA-256 hashes.
- Logo: `4ce7e1fd76960e2745554b8303573b3cda18c22270aab7c28fec9572f5d74d0f`.
- Favicon: `5900bb82a4e378edaddc71b6e929de84481b19eab15077bf3c513f8984526887`.

## Rollback

The old image remains `hoard.sharath.page:retention-20261003-85c26d7`. The old Compose file is saved at `/home/tnfssc/Code/self-hosted/host/.deploy-backups/docker-compose.pre-logo-d16e78a-20261004T155533Z.yml`.

On minipc, restore that file to `docker-compose.yml` in the same directory, then run `docker compose up -d --no-deps --wait --wait-timeout 120 hoard`. Do not remove volumes or use `down -v`.

No deployment work remains. Old image cleanup and the older host service were outside this change.
