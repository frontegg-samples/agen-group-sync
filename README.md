# Google Workspace → Frontegg group sync

Keep a set of Frontegg groups in step with a set of Google Workspace groups, without SCIM.

This is a **complete, runnable reference implementation**, not a snippet. It runs in your
infrastructure, on your schedule, with your credentials. Frontegg cannot see it run.

```
Google Workspace  ──read──►  this tool  ──write──►  Frontegg tenant
  (source of truth)          (your infra)          (groups + memberships)
```

## What this sample showcases

- Authenticating to the **Google Admin SDK Directory API** with a service account and domain-wide
  delegation, using read-only scopes
- Authenticating to Frontegg with an **API token**, and why `UserAuth` endpoints accept one
- Reconciling two directories into a **plan**, then checking that plan before applying it
- **Blast-radius guards** that refuse a destructive pass and stay refused until a human clears them
- Marking the groups you own, so the sync can never touch a group it did not create
- Paginating a Frontegg list endpoint **deterministically**, which is not the default
- Emitting a **freshness signal** so you can alarm on the sync silently not running

## Why it is bigger than the other samples

Directory sync is a write path into your authorization model. The failure that matters is not a
crash — it is a pass that quietly does the wrong thing to every group at once. Most of this code is
the machinery that stops that: ownership marking, quarantine rules, guards, ordering, and a lock.

If you only want the reconciliation logic, read [`src/diff.ts`](src/diff.ts). It is a pure function
with no I/O and no dependencies, and it is where every safety decision lives.

## Quick start

Requires **Node 20.10 or newer**.

```bash
npm ci
npm test                 # 205 tests, no network needed
npm run build

cp .env.example .env     # then fill it in — docs/OPERATIONS.md §4

# Reads everything, writes NOTHING. Always do this first.
node --env-file=.env dist/bin.js --dry-run
```

The dry run prints exactly what it would change:

```
Google groups read:        14
Users to create:            7
Groups to create:           4
Groups to rename:           0
Memberships to REMOVE:      0
Memberships to add:        37
Groups to delete:           0
Groups quarantined:         1

quarantined (skipped, not an error):
  agen-admins: roles-attached
```

When the numbers look right, drop `--dry-run`.

**[docs/OPERATIONS.md](docs/OPERATIONS.md)** is the full manual: permissions to grant, rollout
sequence, what each alarm means, and troubleshooting.

## How it works

Each pass reads both directories, computes a plan, checks it, and applies it in a fixed order:

```
create users → create groups → rename groups → REMOVE memberships → ADD memberships → delete groups
```

Removals run before additions deliberately. A pass can end early — a rate limit, a timeout, a lost
lock — and revocation is the thing you least want left undone.

### What it will not do

|                                        |                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Touch anything outside your prefix** | Only Google groups whose email starts with `SYNC_GROUP_PREFIX` are read as desired state, and only Frontegg groups carrying both that prefix and this tool's ownership marker are ever written to |
| **Write to a group that grants roles** | Quarantined and reported. Writing membership there would be a privilege grant                                                                                                                     |
| **Write to a SCIM-managed group**      | Two writers never converge                                                                                                                                                                        |
| **Delete a user**                      | There is no code path that can. Offboarding is removal from a group                                                                                                                               |
| **Write to Google**                    | It holds read-only scopes                                                                                                                                                                         |
| **Flatten nested groups**              | Direct individual members only; nested entries are reported, not synced                                                                                                                           |

> [!IMPORTANT]
> In Frontegg, a user's effective roles are their own roles **plus the roles of every group they
> belong to**. Adding someone to a group is a permission grant, not a tag. Whoever administers your
> Google groups therefore becomes an implicit Frontegg authorization admin. Decide that
> deliberately — see [docs/OPERATIONS.md §1](docs/OPERATIONS.md).

## Layout

| File                                 | Role                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| [`src/diff.ts`](src/diff.ts)         | The reconciler. Pure function, no I/O. Every safety guard lives here |
| [`src/google.ts`](src/google.ts)     | Directory reader. Read-only scopes                                   |
| [`src/frontegg.ts`](src/frontegg.ts) | Frontegg client. The only component that writes                      |
| [`src/apply.ts`](src/apply.ts)       | Executes a plan in the safe order                                    |
| [`src/sync.ts`](src/sync.ts)         | One pass, start to finish                                            |
| [`src/state.ts`](src/state.ts)       | The sticky guard and the single-pass lock                            |
| [`src/sentinel.ts`](src/sentinel.ts) | The freshness marker your alarm watches                              |
| [`src/http.ts`](src/http.ts)         | Timeouts, retry budget, rate limiting, secret redaction              |
| [`src/cli.ts`](src/cli.ts)           | Argument parsing and exit codes                                      |

## Exit codes

| Code | Meaning                                                          |
| ---- | ---------------------------------------------------------------- |
| `0`  | Pass completed, or dry run completed                             |
| `1`  | Unexpected failure — configuration, network, API                 |
| `2`  | A safety guard is tripped and needs a human. See `--clear-guard` |
| `3`  | Another pass is running; this one was skipped                    |
| `4`  | Pass completed only partially                                    |

Alarm on **the absence of a `0`**, not on the presence of errors. The most likely failure of a sync
is that it quietly stops running.

## Adapting it

The reconciler does not know what Google is. To sync from a different source, produce
`GoogleGroup[]` — `{ id, email, memberEmails }` — from wherever you like and hand it to `diff()`.
`src/google.ts` is the only file that knows about the Directory API.

## Licence

MIT. See [LICENSE](LICENSE).
