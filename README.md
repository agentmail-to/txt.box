# txt.box

Cloud-synced text editor with conflict-free realtime collaboration.

- **Frontend**: Vite + vanilla TypeScript, plain `<textarea>`, Yjs CRDT
- **Hosting**: Cloudflare Pages
- **Backend**: Cloudflare Workers (api-session + snapshotter)
- **Storage**: S2 streams (one per doc) + R2 snapshots

## Prerequisites

- Node.js >= 20
- pnpm
- Wrangler CLI (>= 4.0)
- S2 account with separate dev/prod basins + access tokens
- Cloudflare account with `txt.box` and `txtbox.dev` domains

## Setup

```bash
pnpm install
```

## Environments

Dev and prod are fully isolated -- separate worker scripts, R2 buckets, S2 basins, and domains.

| Resource | Dev | Prod |
|---|---|---|
| Pages project | `txtbox` (dev branch) | `txtbox` (main branch) |
| Domain | `txtbox.dev` | `txt.box` |
| API worker | `txtbox-api-session-dev` | `txtbox-api-session-prod` |
| API domain | `api.txtbox.dev` | `api.txt.box` |
| Snapshotter | `txtbox-snapshotter-dev` | `txtbox-snapshotter-prod` |
| R2 bucket | `txtbox-snapshots-dev` | `txtbox-snapshots-prod` |
| S2 basin | `txtbox-dev` | `txtbox-prod` |

## Configuration

Non-secret vars (`S2_BASIN`, `R2_PUBLIC_BASE`) are in `wrangler.toml` per environment. Only the S2 access token is a secret:

```bash
# api-session
cd workers/api-session
wrangler secret put S2_ACCESS_TOKEN --env dev
wrangler secret put S2_ACCESS_TOKEN --env prod

# snapshotter
cd workers/snapshotter
wrangler secret put S2_ACCESS_TOKEN --env dev
wrangler secret put S2_ACCESS_TOKEN --env prod
```

For local development, copy the `.dev.vars.example` files:

```bash
cp workers/api-session/.dev.vars.example workers/api-session/.dev.vars
cp workers/snapshotter/.dev.vars.example workers/snapshotter/.dev.vars
# Then edit .dev.vars with your S2 access token
```

## Development

```bash
# Frontend (uses http://localhost:8787 in dev)
pnpm dev

# Workers (each in its own terminal)
cd workers/api-session && pnpm dev
cd workers/snapshotter && pnpm dev
```

## Deploy

```bash
# Dev
cd app && pnpm deploy:dev
cd workers/api-session && pnpm deploy:dev
cd workers/snapshotter && pnpm deploy:dev

# Prod
cd app && pnpm deploy:prod
cd workers/api-session && pnpm deploy:prod
cd workers/snapshotter && pnpm deploy:prod
```

R2 buckets are auto-provisioned by wrangler on first deploy. Custom domains need to be set up once in the Cloudflare dashboard:
- Pages: `txt.box` on production, `txtbox.dev` on the dev branch
- R2: `snapshots.txt.box` and `snapshots.txtbox.dev`

## Architecture

- Every URL path on `txt.box` is a document: `txt.box/<docId>`
- API lives on `api.txt.box` and proxies S2 operations server-side (`/session`, `/append`, `/read`)
- The browser never receives S2 credentials; it sends Yjs updates to the API Worker
- Each doc is an S2 stream (`doc:<docId>`) with Yjs update records
- Snapshots are periodically written to R2 for fast load times
