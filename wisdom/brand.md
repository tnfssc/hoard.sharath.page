# Hoard brand

## Design

The mark is a heavy H: two storage uprights joined by a shelf. The right upright has a folded-file corner, not an upload arrow. A dark rounded-square tile gives it a strong silhouette beside the existing homepage and admin wordmarks.

Colors are sRGB equivalents of tokens.css: ink/graphite `#12171b`, paper `#f7f5ec`, and the primary yellow accent `#f6ce00` (clipped to sRGB). The accent is only the fold. No gradients, shadows, fonts, or hairline details.

## Source and generation

Edit `public/logo.svg`. Its 64-unit grid is shared by both PNGs. From the repository root:

```sh
./scripts/generate-brand.sh
```

Install the development tool `rsvg-convert` first (Debian/Ubuntu: `librsvg2-bin`). Generated with librsvg 2.62.1 / Cairo 1.18.4. It writes `public/logo.png` at 1024×1024 and `public/favicon.png` at 256×256. Both are RGBA with transparent outer corners. Commit both exports after source edits. No app runtime dependencies were added; existing embedded PNG routes and layouts are unchanged. SVG is the editable source, not a new served route.

## Checks

- Read README.md, CONTRIBUTING.md, tokens.css, homepage/admin CSS and their logo placements.
- Visually inspected both PNG exports downsampled to 16, 32 and 64px on paper, including enlarged pixel views. Also inspected the favicon at those sizes on a dark background. The H stays legible; the fold becomes a small color cue at 16px, intentionally not a detail needed for recognition.
- Confirmed PNG dimensions and transparency. Regenerated twice and checked SHA-256 hashes: identical on the tool versions above.
- `go test ./...` passed, including existing embedded brand-asset route tests. `go vet ./...` passed.

No known design blockers. Raster bytes may differ with other librsvg/Cairo versions. Browsers can keep an old image at the same URL even after server bytes change. Homepage and admin references now use hash-versioned URLs (/logo.png?v=4ce7e1fd, /favicon.png?v=5900bb82) so browsers request fresh images. PNG routes and bytes are unchanged. The homepage has no explicit cache policy; admin is no-store. Public hash checks prove the server has new bytes, not that existing browser caches fetched them.

## Handoff

The parent reviewed the exported mark and fresh 16px and 32px renders, then brought commit `0eb343b444f96ad8bb99343accdeda5ebcda3f6b` into this branch as `3aefef3`. `go test ./...` and `go vet ./...` passed here too. No code work remains. Deployment was not part of this change.

Worker checkout: `/home/tnfssc/.bruv/worktrees/t3code-b3a275a7-3c93fe2dfab8-task_db807ba3`, branch `bruv/redesign-hoard-logo-db807ba3`. Browser preview tools were off for this thread, so no in-page screenshot was taken. The local test preview was stopped after review.

The logo was later merged and deployed to minipc. See [deployment notes](deployment.md) for the live revision, checks, and rollback.
