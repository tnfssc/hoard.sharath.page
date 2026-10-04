# Deployment on minipc

## Current release

PR [#11](https://github.com/tnfssc/hoard.sharath.page/pull/11) merged on 2026-10-04 as `9c32ccab7721095c98edb133e9eeb91831ce60c4`. The deployed source is its head `0523e7533b507af9cadd029a95e5b3c5f45b8bb6`. Image: `hoard.sharath.page:logo-cache-0523e75`, Docker image ID `sha256:d605291c098180c87b6ca6350226875ef3d5dccca3a3acb79607c3cd90f97a85`. Source archive: `/home/tnfssc/Code/self-hosted/host/releases/0523e75`.

The service is healthy and the data volume is unchanged. Both live pages now request `/logo.png?v=4ce7e1fd` and `/favicon.png?v=5900bb82`. Those exact URLs returned 200 and matched the source bytes. Public health returned 200. A normal page reload now asks for a new image URL instead of reusing the old seven-day browser cache. CI and local tests passed.

## First logo release

The user asked to merge the logo change and update `tnfssc@minipc`. PR [#10](https://github.com/tnfssc/hoard.sharath.page/pull/10) merged into `develop` on 2026-10-04 at `d16e78a108d7ad6214458e3426579b0f6c6bf28f`. CI and Docker Build were green.

The first logo image was `hoard.sharath.page:logo-d16e78a`. Docker image ID: `sha256:27deba3728d97d0c18a3135633a4ee53723a12ceab29614d70159eef3c8e725e`. The image revision label is the merged commit. Build source is at `/home/tnfssc/Code/self-hosted/host/releases/d16e78a`, made with `git archive` of that commit.

## Service

Compose lives at `/home/tnfssc/Code/self-hosted/host/docker-compose.yml`. The service is `hoard`, container `host-hoard-1`, network `host_default`. The unchanged `host_data` volume is mounted at `/data`. Only the hoard image was changed. The existing .env and Cloudflare tunnel settings were kept. There is also an older `host-host-1` container; it was not removed.

SSH works with the current key. The remote login shell is fish. Use `bash -s` for shell scripts; plain `set -e` does not mean the same thing there. When feeding a script to SSH stdin, redirect `docker compose exec` stdin from `/dev/null` or it can consume the rest of the script.

## Checks

- `docker compose up -d --no-deps --wait --wait-timeout 120 hoard` completed. Container health is healthy.
- `docker exec host-hoard-1 /hoard healthcheck` passed.
- Public `https://hoard.sharath.page/healthz` and `/admin` returned 200.
- Both regular logo URLs and cache-busted URLs returned 200 and matched source SHA-256 hashes. That proved the server served new bytes, not that existing browsers refreshed a same-URL cached image. The homepage has no explicit cache policy and admin is no-store; both now use hash-versioned logo and favicon URLs. PNG routes and assets remain unchanged.
- Logo: `4ce7e1fd76960e2745554b8303573b3cda18c22270aab7c28fec9572f5d74d0f`.
- Favicon: `5900bb82a4e378edaddc71b6e929de84481b19eab15077bf3c513f8984526887`.

## Rollback

For the current cache fix, restore `/home/tnfssc/Code/self-hosted/host/.deploy-backups/docker-compose.pre-logo-cache-0523e75-20261004T160518Z.yml`. This returns to `hoard.sharath.page:logo-d16e78a`. Restart only hoard with the command below.

### Before the first logo release

The old image remains `hoard.sharath.page:retention-20261003-85c26d7`. The old Compose file is saved at `/home/tnfssc/Code/self-hosted/host/.deploy-backups/docker-compose.pre-logo-d16e78a-20261004T155533Z.yml`.

On minipc, restore that file to `docker-compose.yml` in the same directory, then run `docker compose up -d --no-deps --wait --wait-timeout 120 hoard`. Do not remove volumes or use `down -v`.

No deployment work remains. Old image cleanup and the older host service were outside this change.
