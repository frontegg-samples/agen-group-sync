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

## Setting up Google credentials

The sync reads your directory as a **service account with domain-wide delegation**, impersonating a
super-admin. The Directory API will not answer a bare service-account token, so both halves — the
key _and_ the delegation — are required.

It needs **three read-only scopes**. Groups and their members tell it who should be in what; the
user scope resolves those member emails to real people, so new Frontegg users are created with a
name and suspended accounts are never granted access.

```
https://www.googleapis.com/auth/admin.directory.group.readonly
https://www.googleapis.com/auth/admin.directory.group.member.readonly
https://www.googleapis.com/auth/admin.directory.user.readonly
```

All three are `.readonly`. This tool never writes to Google.

### 1 · Create the service account and key

In the **[Google Cloud Console](https://console.cloud.google.com/)**, using any project (a
dedicated one is tidier):

1. **APIs & Services → Library** → search **Admin SDK API** → **Enable**.
   Without this every call returns `403 accessNotConfigured`.
2. **APIs & Services → Credentials → Create credentials → Service account**.
   Name it something recognisable, e.g. `frontegg-group-sync`. No project roles are needed — its
   access comes from the delegation in step 2, not from IAM.
3. Open the new service account → **Keys → Add key → Create new key → JSON**. The file downloads
   once and cannot be re-downloaded.
4. Still on the service account, copy the **Unique ID** from the _Details_ tab. It is a long number
   like `109876543210987654321`. **You need this in step 2, and it is not the email address.**

From the downloaded JSON you need exactly two fields:

| JSON field     | Environment variable                                          |
| -------------- | ------------------------------------------------------------- |
| `client_email` | `GOOGLE_CLIENT_EMAIL`                                         |
| `private_key`  | `GOOGLE_PRIVATE_KEY_FILE` (preferred) or `GOOGLE_PRIVATE_KEY` |

> [!TIP]
> Write the private key to its own file and point `GOOGLE_PRIVATE_KEY_FILE` at it — that is the
> shape a secret manager mounts. If you must inline it, the `\n` escapes are handled for you, but
> the tool warns on every run.

### 2 · Authorise domain-wide delegation

This is the step people get wrong, and it produces the single most common error.

In the **[Google Admin Console](https://admin.google.com/)**, as a super-admin:

**Security → Access and data control → API controls → Domain-wide delegation → Manage
domain-wide delegation → Add new**

| Field            | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| **Client ID**    | The **Unique ID number** from step 1.4 — _not_ the service account email |
| **OAuth scopes** | The three scopes above, **comma-separated on one line, no spaces**       |

Paste the scopes exactly as:

```
https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/admin.directory.group.member.readonly,https://www.googleapis.com/auth/admin.directory.user.readonly
```

Then **Authorise**. Propagation is usually seconds but can take a few minutes.

### 3 · Pick the admin to impersonate

Set `GOOGLE_IMPERSONATE_SUBJECT` to a **super-admin's** email address. The service account acts as
this person when reading the directory, which is what makes `GOOGLE_CUSTOMER_ID=my_customer`
resolve to your organisation.

A delegated user who is not a super-admin will usually authenticate and then return `403` on the
group or user reads.

### 4 · Verify before you configure anything else

```bash
node --env-file=.env dist/bin.js --dry-run
```

A working setup prints a group count and a user count. If it does not:

| Error                     | What it means                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unauthorized_client`     | The Client ID in the delegation entry is wrong — almost always the service account **email** was pasted instead of the **numeric Unique ID**. Recheck step 1.4.                 |
| `invalid_grant`           | `GOOGLE_IMPERSONATE_SUBJECT` is not a real user in this domain, or the clock on the host is badly skewed.                                                                       |
| `403 accessNotConfigured` | The Admin SDK API is not enabled on the Cloud project. Step 1.1.                                                                                                                |
| `403` on groups or users  | The scopes in the delegation entry do not match the three above exactly, or the impersonated user is not a super-admin. A typo or trailing space in the scope string is enough. |
| Groups read but `0 users` | The `admin.directory.user.readonly` scope was not included. Re-add all three together — editing a delegation entry replaces the whole scope list.                               |

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
