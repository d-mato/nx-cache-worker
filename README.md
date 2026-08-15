# nx-cache-worker

Self-hosted [Nx remote cache](https://nx.dev/docs/kb/self-hosted-caching) server running on Cloudflare Workers + R2. No server to operate, no S3 credentials in CI, free egress.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/d-mato/nx-cache-worker)

## Why this exists

Nx deprecated `@nx/s3-cache`, `@nx/gcs-cache`, `@nx/azure-cache`, and `@nx/shared-fs-cache` in May 2026 due to [CVE-2025-36852 (CREEP)](https://nx.dev/blog/cve-2025-36852-critical-cache-poisoning-vulnerability-creep): with direct bucket access, a single credential grants read/write to the whole cache, so anyone with the credential can plant a poisoned artifact under a hash key *before* the legitimate build produces it. The official alternatives are Nx Cloud, disabling remote caching, or [running your own cache server](https://nx.dev/docs/kb/self-hosted-caching). This project is the third option, built for Cloudflare:

- **No server to run** — a Worker and an R2 bucket, deployed in minutes.
- **No storage credentials in CI** — the Worker reaches R2 through a binding; CI only holds a bearer token whose scope *you* control.
- **Write-once semantics** — a cache entry can never be overwritten (enforced atomically by a conditional R2 put), closing the overwrite half of the poisoning problem.
- **Read-only tokens for untrusted branches** — PRs can consume the cache but never write to it, closing the other half.

## How it works

The Worker implements the two endpoints of the Nx self-hosted cache OpenAPI spec (built into Nx 21+, no plugin needed):

| Endpoint | Behavior |
|---|---|
| `PUT /v1/cache/{hash}` | Stores the artifact. `200` on success, `403` with a read-only token, `409` if the hash already exists (write-once). |
| `GET /v1/cache/{hash}` | Returns the artifact as `application/octet-stream`, or `404`. |

Both require `Authorization: Bearer <token>`. Two tokens are configured as Worker secrets:

| Secret | Grants |
|---|---|
| `ACCESS_TOKEN` | read + write — for trusted branches (e.g. `main`) |
| `READ_ONLY_ACCESS_TOKEN` | read only — for PRs and untrusted environments |

## Deploy

### One-click

Use the **Deploy to Cloudflare** button above. Cloudflare clones the repo into your account, provisions the R2 bucket, prompts you for the two token secrets, and sets up CI so pushes auto-deploy.

Generate strong tokens with:

```sh
openssl rand -hex 32
```

### Manual

```sh
git clone https://github.com/d-mato/nx-cache-worker
cd nx-cache-worker
npm install

npx wrangler r2 bucket create nx-cache
openssl rand -hex 32 | npx wrangler secret put ACCESS_TOKEN
openssl rand -hex 32 | npx wrangler secret put READ_ONLY_ACCESS_TOKEN

npx wrangler deploy
```

Adjust `bucket_name` in `wrangler.jsonc` if you named the bucket differently.

## Configure Nx

No package to install — Nx 21+ reads two environment variables:

```sh
NX_SELF_HOSTED_REMOTE_CACHE_SERVER=https://nx-cache-worker.<your-account>.workers.dev
NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=<token>
```

### CI example (GitHub Actions)

Give PRs the read-only token and trusted branches the read-write token:

```yaml
env:
  NX_SELF_HOSTED_REMOTE_CACHE_SERVER: https://nx-cache-worker.<your-account>.workers.dev
  NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN: >-
    ${{ github.event_name == 'pull_request'
        && secrets.NX_CACHE_RO_TOKEN
        || secrets.NX_CACHE_RW_TOKEN }}
```

## Operational notes

**Multiple monorepos.** Nx task hashes are derived from all task inputs, so artifacts from different workspaces do not collide; repos that share a trust domain can safely share one deployment. The bearer tokens are the trust boundary — if two repos should not be able to poison each other's cache, give each its own deployment (the same code deployed under a different `name` with its own bucket and tokens).

**Cache expiration.** Set an [R2 lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) on the bucket to delete objects some number of days after upload. The Nx client treats an expired entry as a plain cache miss.

**Upload size limits.** Request bodies are capped by your Cloudflare plan: 100 MB (Free/Pro), 200 MB (Business), 500 MB (Enterprise). Oversized cache artifacts fail to upload; the build still succeeds, it just isn't cached remotely.

**Health check.** `GET /health` responds `{"status":"ok"}` without authentication.

## Troubleshooting

**"Nx read the output from the cache" but no files were restored.** Nx 21+ tracks cache metadata in a SQLite database under `.nx/workspace-data`, separate from the artifacts in `.nx/cache`. Deleting only `.nx/cache` desyncs the two and produces phantom cache hits. Use `nx reset` to clear cache state when testing.

**Self-signed certificates / custom CAs.** The Nx cache client validates TLS against the OS trust store and ignores `NODE_EXTRA_CA_CERTS`. Workers get publicly trusted certificates automatically, so this problem does not arise with a `workers.dev` URL or a Cloudflare-proxied custom domain.

## Development

```sh
npm run dev        # local dev server (uses .dev.vars for tokens)
npm test           # vitest (@cloudflare/vitest-pool-workers)
npm run typecheck
npm run lint
```

## License

[MIT](./LICENSE)
