# PlatesCloud

The server side of Plates: one Cloudflare Worker that writes recipes with Granite on Workers AI and, when the cook taps Decide for me, asks TypeSafe's Jev to pick one of the recipe ideas. Every call is signed with App Attest, and each device has a Durable Object that holds its key, its assertion counter, and its daily counts.

## Develop and deploy

```bash
npm install && npm test
npm run dev
npm run deploy:staging
npm run deploy:production
```

CI tests every push and deploys on published GitHub Releases: a prerelease goes to staging, a full release to production, using a `CLOUDFLARE_API_TOKEN` secret scoped to Edit Cloudflare Workers.

The deploy jobs run in the `staging` and `production` GitHub Environments. Each environment holds the vars below as Variables and the secrets below as Secrets; CI passes the vars with `--var` and uploads the secrets before deploying.

## Settings

Plain vars live in `cloudflare.config.ts` (and `wrangler.jsonc` while CI still deploys with Wrangler), and are empty until set. An endpoint that needs a missing setting answers 503 rather than running unchecked.

| Var | Meaning |
| --- | --- |
| `APPLE_TEAM_ID` | The 10-character Apple team ID |
| `APP_BUNDLE_ID` | The app's bundle ID, `com.tsubuzaki.Plates` |
| `APP_ATTEST_ENVIRONMENT` | `development` for debug builds, `production` for TestFlight and the App Store |
| `WRITE_DAILY_LIMIT` | Granite calls per device per day, ideas and recipes together |
| `DECIDE_DAILY_LIMIT` | Decide for me picks per device per day |

Outside CI, secrets are set with `npx wrangler secret put NAME --env staging` (and again for `--env production`), or in a gitignored `.dev.vars` copied from `.dev.vars.example`:

| Secret | Where it comes from |
| --- | --- |
| `CHALLENGE_SECRET` | Any long random string; signs attestation challenges |
| `JEV_API_KEY` | A TypeSafe API key |

Workers AI needs no key: the `AI` binding runs on the account the Worker is deployed to.

## Endpoints

Everything is `POST` except `/health`. The signed endpoints take three headers:

| Header | Value |
| --- | --- |
| `X-Plates-Key-Id` | The App Attest key ID, base64 |
| `X-Plates-Assertion` | `DCAppAttestService.generateAssertion` over the SHA-256 of the exact request body, base64 |
| `X-Plates-UTC-Offset` | The cook's offset from UTC in minutes, so a day ends at their midnight |

| Path | Signed | What it does |
| --- | --- | --- |
| `/v1/challenge` | No | Returns `{ "challenge" }`, good for five minutes |
| `/v1/attest` | No | Takes `{ keyId, attestation, challenge }`. The attestation's client data hash is the SHA-256 of the challenge string's UTF-8 bytes. Registers the key once |
| `/v1/chat/completions` | Yes | OpenAI Chat Completions in and out, streamed when `stream` is true. Always Granite 4.0 H-Micro; `max_tokens` is capped at 1,400 |
| `/v1/decide` | Yes | Takes `{ requestId, request, ingredients, tools, ideas: [{ title, summary }] }` and returns `{ index, confidence, probabilities, remaining }` |
| `/v1/decide/remaining` | Yes | Returns `{ remaining }` for today |

A metered call that fails upstream is given back. A retried Decide for me with the same `requestId` returns the first answer without counting again. Every metered response carries `X-Plates-Remaining`, and a call past the limit gets 429.
