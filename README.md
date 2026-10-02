# PlatesCloud

The server side of Plates: one Cloudflare Worker that writes recipes with Gemma 4 on Workers AI and, when the cook taps Decide for me, asks TypeSafe's Jev to pick one of the recipe ideas. Jev also says which seasonings and garnishes can be seen on a finished dish, for its icon. Every call is signed with App Attest, and each device has a Durable Object that holds its key, its assertion counter, and its daily counts.

## Develop and deploy

```bash
npm install && npm test
npm run dev
npm run deploy:staging
npm run deploy:production
```

CI tests every push and deploys on published GitHub Releases: a prerelease goes to staging, a full release to production, using a `CLOUDFLARE_API_TOKEN` secret scoped to Edit Cloudflare Workers.

The deploy jobs run in the `staging` and `production` GitHub Environments. Each environment holds the vars below as Variables and the secrets below as Secrets; CI exports both to `cf deploy`, which reads the vars in `cloudflare.config.ts` and uploads the secrets with `--secrets-file`.

## Settings

Plain vars are read from the environment by `cloudflare.config.ts` at deploy time, and are empty until set. An endpoint that needs a missing setting answers 503 rather than running unchecked.

| Var | Meaning |
| --- | --- |
| `APPLE_TEAM_ID` | The 10-character Apple team ID |
| `APP_BUNDLE_ID` | The app's bundle ID, `com.tsubuzaki.Plates` |
| `APP_ATTEST_ENVIRONMENT` | `development` for debug builds, `production` for TestFlight and the App Store |
| `WRITE_DAILY_LIMIT` | Recipes Gemma writes per device per day |
| `IDEATE_DAILY_LIMIT` | Sets of ideas Gemma writes per device per day |
| `DECIDE_DAILY_LIMIT` | Decide for me picks per device per day |
| `TOPPINGS_DAILY_LIMIT` | Dish icon questions per device per day |

The four limits are defaults. A device whose Durable Object has a row in its `limits` table (`kind` is `write`, `ideate`, `decide`, or `toppings`, `daily` a whole number) uses that instead, so one device can be given more or fewer calls without a deploy. Each device's Durable Object is named by its key ID in base64url, and `limits` is its only SQL table: the key, the counter, and the daily counts stay in its key-value storage.

For example, `INSERT OR REPLACE INTO limits (kind, daily) VALUES ('write', 50)` gives a device 50 Gemma calls a day.

Outside CI, secrets are uploaded with `npm run deploy:staging -- --secrets-file secrets.json` (or `deploy:production`), or kept in a gitignored `.dev.vars` copied from `.dev.vars.example`:

| Secret | Where it comes from |
| --- | --- |
| `CHALLENGE_SECRET` | Any long random string; signs attestation challenges |
| `JEV_API_KEY` | A TypeSafe API key |
| `SKIP_APP_ATTEST` | `true` to accept unsigned requests to `localhost`, so a debug build in Simulator can call `npm run dev`. Ignored on any other host; never set it in a deploy |

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
| `/v1/chat/completions` | Yes | OpenAI Chat Completions in and out, streamed when `stream` is true. Always Gemma 4 26B A4B; `max_tokens` is capped at 1,400 |
| `/v1/ideate` | Yes | The same as `/v1/chat/completions`, for the dish ideas: counted against `IDEATE_DAILY_LIMIT`, with `max_tokens` capped at 500 |
| `/v1/decide` | Yes | Takes `{ requestId, request, ingredients, tools, ideas: [{ title, summary }] }` and returns `{ index, confidence, probabilities, remaining }` |
| `/v1/toppings` | Yes | Takes `{ dish, steps: [{ title, points }], ingredients }` and returns `{ visible, remaining }`, where `visible` holds Jev's probability, line by line, that the ingredient can be seen on the dish as it is served |
| `/v1/limits` | Yes | Returns today's `{ limit, remaining }` for each of `write`, `ideate`, `decide`, and `toppings`, without counting anything |

A metered call that fails upstream is given back. A retried Decide for me with the same `requestId` returns the first answer without counting again. Every metered response carries `X-Plates-Remaining`, and a call past the limit gets 429.
