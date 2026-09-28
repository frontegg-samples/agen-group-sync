# Operations manual

Everything you need to run this in production. Read sections 1 to 3 before you install anything —
they contain facts that are not obvious from the API and that change how you should deploy.

| Section                                                                                   | Read it when                                              |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [1 · What this does, and what it will not do](#1--what-this-does-and-what-it-will-not-do) | Before you commit to the approach                         |
| [2 · Before you start](#2--before-you-start)                                              | Before you install                                        |
| [3 · Permissions to grant](#3--permissions-to-grant)                                      | Before you install — this is the section people get wrong |
| [4 · Install and configure](#4--install-and-configure)                                    | At install time                                           |
| [5 · Your first dry run](#5--your-first-dry-run)                                          | Immediately after installing                              |
| [6 · Going live](#6--going-live)                                                          | When the dry run looks right                              |
| [7 · Operating it day to day](#7--operating-it-day-to-day)                                | Once it is live                                           |
| [8 · When it stops](#8--when-it-stops)                                                    | **Before** it stops. Set the alarm on day one             |
| [9 · Troubleshooting](#9--troubleshooting)                                                | When something is wrong                                   |
| [10 · Limits](#10--limits)                                                                | Before you rely on it for anything security-critical      |

---

## 1 · What this does, and what it will not do

Google Workspace is the source of truth. Every pass reads your directory, reads your Frontegg
tenant, works out the difference, checks that difference against safety limits, and applies it in a
fixed order:

```
create users → create groups → rename groups → REMOVE memberships → ADD memberships → delete groups
```

Removals run before additions deliberately. A pass can end early — a rate limit, a timeout, a lost
lock — and revocation is the thing you least want left undone.

### What it will not do

- **Touch anything outside your configured prefix.** Groups you manage by hand are invisible to it.
  Only Google groups whose email starts with the prefix are read as desired state, and only Frontegg
  groups carrying both the prefix and this tool's ownership marker are ever written to.
- **Write to a group that grants roles.** Such a group is quarantined and reported, never modified.
  Writing membership there would be a privilege grant.
- **Write to a group SCIM already manages.** Two writers never converge.
- **Delete a user.** There is no code path that can. Offboarding is removal from a group.
- **Write to Google.** It holds read-only scopes and cannot corrupt your directory.
- **Flatten nested groups.** A Google group containing another group syncs only its direct
  individual members. The nested entries are reported in the pass summary so you can see them.
- **Grant access to a suspended or archived Google account.** Membership status and account status
  are different facts — Google will report a suspended person as an `ACTIVE` member of a group. The
  sync checks the account itself and skips them, reporting `account=suspended`.

> [!IMPORTANT]
> Adding a user to a Frontegg group grants them that group's roles. Whoever administers your Google
> groups therefore becomes an implicit Frontegg authorization admin. If your Google admin population
> is broader than your Frontegg admin population, this sync widens it. That is a trust-boundary
> decision to make deliberately, not a side effect to discover.

---

## 2 · Before you start

| You need                                | Detail                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Node.js 20.10 or newer**              | No other runtime dependency. `npm ci` installs only test-time packages.                                                                    |
| **A Google Cloud service account**      | With **domain-wide delegation** enabled, and a super-admin to impersonate. The Directory API will not answer a bare service-account token. |
| **A Frontegg API token**                | Client id and secret, with exactly seven permissions. See §3.2.                                                                            |
| **Your tenant id and application id**   | Both required. The application id is not optional — see §4.1.                                                                              |
| **A naming convention in Google**       | A prefix such as `agen-` on every group you want synced. Minimum two characters.                                                           |
| **Somewhere to persist one small file** | The tool keeps a lock and a tripped-guard flag on disk. It must survive between passes.                                                    |
| **Somewhere to run it on a schedule**   | Cron, a systemd timer, a container with a volume, or a scheduled task. See §6 for the concurrency constraint.                              |

> [!NOTE]
> Each pass makes one paginated sweep of your Google user directory, in addition to reading groups
> and their members. On a very large directory that sweep is the most expensive part of a pass. It is
> done once per pass rather than once per member, which would be far slower and hit quota sooner.

### 2.1 Your real offboarding lag is longer than the sync interval

Removing someone from a Google group does not revoke their Frontegg access at the next pass. The
full chain is:

```
poll interval + group cache (about 30s) + pass duration + the user's remaining token lifetime
```

**The last term is the largest, and this tool does not control it.** A token minted before the
removal keeps its group-derived roles until it expires. If you need hard, immediate revocation, this
sync is not the mechanism — deactivate the user in Frontegg directly.

---

## 3 · Permissions to grant

This is the section people get wrong, in both directions: too few permissions and the sync fails
halfway through a pass; too many and the sync can escalate its own privileges.

### 3.1 Google Workspace

Create a service account, enable domain-wide delegation, and authorise exactly these **three**
scopes. The step-by-step walkthrough, including where each value comes from and how to verify it, is
in the [README](../README.md#setting-up-google-credentials).

```
https://www.googleapis.com/auth/admin.directory.group.readonly
https://www.googleapis.com/auth/admin.directory.group.member.readonly
https://www.googleapis.com/auth/admin.directory.user.readonly
```

| Scope                   | Why it is needed                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `group.readonly`        | List the groups in your directory                                                                                                  |
| `group.member.readonly` | List who is in each group — the desired state                                                                                      |
| `user.readonly`         | Resolve member emails to people: create Frontegg users with a real name, and never grant access to a suspended or archived account |

All three are read-only. This tool never writes to Google, and granting it a write scope would put
your directory at risk for no benefit.

> [!NOTE]
> Editing a delegation entry **replaces** its whole scope list. If you add the user scope later,
> re-paste all three together or the group scopes are silently dropped.

You also need a super-admin for the service account to impersonate
(`GOOGLE_IMPERSONATE_SUBJECT`). Domain-wide delegation requires one; the Directory API will not
return a customer's groups to an unimpersonated service account.

### 3.2 Frontegg

Grant the sync principal these **seven** permissions, and no others:

| Permission            | Used for                                    |
| --------------------- | ------------------------------------------- |
| `GROUPS_READ`         | Listing groups                              |
| `GROUPS_WRITE`        | Creating and renaming a group               |
| `GROUPS_DELETE`       | Deleting a group Google no longer has       |
| `GROUPS_USERS_WRITE`  | Adding members                              |
| `GROUPS_USERS_DELETE` | Removing members                            |
| `USERS_READ`          | Listing users, to map an email to a user id |
| `USERS_WRITE`         | Creating a user who is new to the tenant    |

> [!WARNING]
> Do **not** grant `GROUPS_ROLES_WRITE`. A principal that can attach roles to a group _and_ add
> users to that group can grant itself anything. This tool never attaches a role and does not need
> the permission.

### 3.3 Credential hygiene

- Mint the token with an explicit expiry. If you omit it, the token never expires.
- **Revocation is not instant.** Deleting the token stops future exchanges, but an already-minted
  session stays valid until its own expiry. That residual window is your real revocation time.
- Prefer the `_FILE` form of every secret variable, pointing at a file mounted from your secret
  manager. The tool warns on every run when a secret is set inline.
- The tool scrubs your client id, secret and private key from every error message and log line it
  produces. Verify this holds for whatever you wrap it in.

---

## 4 · Install and configure

```bash
npm ci          # test-time dependencies only
npm test        # 205 tests, no network required
npm run build   # compiles to dist/
```

Copy `.env.example` to `.env` and fill it in:

| Variable                                                        | Meaning                                                                                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_CLIENT_EMAIL`                                           | Service-account address, ending `.iam.gserviceaccount.com`                                                                             |
| `GOOGLE_PRIVATE_KEY_FILE`                                       | Path to the service-account private key in PEM form. Inline `GOOGLE_PRIVATE_KEY` also works and warns.                                 |
| `GOOGLE_IMPERSONATE_SUBJECT`                                    | The super-admin to impersonate                                                                                                         |
| `GOOGLE_CUSTOMER_ID`                                            | Defaults to `my_customer`, correct for a single-domain setup                                                                           |
| `FRONTEGG_BASE_URL`                                             | Defaults to `https://api.frontegg.com`. Use your region's host if different. Must be https.                                            |
| `FRONTEGG_CLIENT_ID_FILE`<br>`FRONTEGG_SECRET_FILE`             | Paths to the API token credentials                                                                                                     |
| `FRONTEGG_TENANT_ID`                                            | The tenant whose groups are being synced                                                                                               |
| `FRONTEGG_APPLICATION_ID`                                       | **Required.** See §4.1                                                                                                                 |
| `SYNC_GROUP_PREFIX`                                             | Defaults to `agen-`. Minimum two characters — a one-character prefix is refused at startup because it would match most of a directory. |
| `SYNC_GUARD_FRACTION`<br>`SYNC_GUARD_FLOOR`<br>`SYNC_GUARD_CAP` | Blast-radius limits: `0.2`, `3`, `500` by default. See §8.                                                                             |
| `SYNC_MAX_WRITES_PER_PASS`                                      | Hard ceiling on writes in one pass, `2000` by default                                                                                  |
| `SYNC_STATE_PATH`                                               | Where the lock and tripped-guard flag live. **Must persist between passes.**                                                           |

Every problem is reported at once, at startup, before anything is written. A pass that discovers a
missing application id halfway through has already changed your tenant.

### 4.1 Two things that will bite you on day one

**User creation needs the application id.** It is not derived from your token. Without
`FRONTEGG_APPLICATION_ID` you get a `400` that does not explain itself. The tool requires it at
startup so you find out immediately rather than mid-pass.

**User creation is rate limited to 30 requests per 60 seconds, per source IP.** If you onboard more
than 30 people at once from a single NAT address you would hit it. The tool paces its own user
creation to stay under the limit and honours any `Retry-After` it is given — but it is why a first
pass onboarding hundreds of people takes minutes rather than seconds.

---

## 5 · Your first dry run

A dry run reads everything, prints exactly what it would do, and writes nothing at all. **Always do
this first**, and again after any configuration change.

```bash
node --env-file=.env dist/bin.js --dry-run
```

Check four things before going further:

1. **Is the Google group count what you expect?** If it is far too high, your prefix is too broad.
   If it is zero, the sync refuses to run at all rather than treating an empty read as an
   instruction to delete everything.
2. **Are there deletions you did not expect?** On a first run there should be none.
3. **Are there removals you did not expect?** Also none, on a first run.
4. **What is quarantined, and why?** Quarantine is not an error. It means the tool found a group it
   refuses to touch and is telling you rather than guessing.

| Quarantine reason           | What it means                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `roles-attached`            | The group grants roles. Writing membership would be a privilege grant. Remove the roles, or exclude the group from the prefix. |
| `scim-managed`              | SCIM already writes this group's membership. Two writers never converge. Pick one.                                             |
| `owner-prefix-disagreement` | The ownership marker and the name prefix disagree. Usually a group renamed by hand, or a prefix changed without a migration.   |
| `duplicate-google-group-id` | Two Frontegg groups claim the same Google group. Delete the stale one.                                                         |
| `malformed-metadata`        | The ownership marker is present but unreadable. Usually hand-edited.                                                           |
| `policy-referenced`         | Google no longer has this group but a live policy still targets it. Deleting it would silently detach that policy.             |

---

## 6 · Going live

Do not jump from a dry run to a five-minute schedule.

| Step | Do this                                                       | Move on when                                                                                  |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1    | Dry run against your real directory and tenant                | The four checks in §5 all look right                                                          |
| 2    | One real pass, run by hand. Watch it finish                   | Frontegg matches what the plan said, and the marker group `agen-group-sync-status` now exists |
| 3    | Remove one person from one Google group. Run one pass by hand | That person, and only that person, lost that membership                                       |
| 4    | Put it on a schedule. Start hourly, not every five minutes    | It has run clean for a day and your §8 alarm is live                                          |

> [!CAUTION]
> The lock this tool uses is a file on local disk. It stops two passes overlapping on **one
> machine**. It does **not** stop two machines, two containers without a shared volume, or two
> concurrent serverless invocations from racing on the same writes. If your scheduler can start a
> second copy before the first finishes, either constrain it to one at a time or put the state file
> on shared storage.

---

## 7 · Operating it day to day

### 7.1 Exit codes

| Code | Meaning                                                | What to do                                      |
| ---- | ------------------------------------------------------ | ----------------------------------------------- |
| `0`  | Pass completed, or dry run completed                   | Nothing                                         |
| `1`  | Unexpected failure — configuration, network, API       | Read the message. §9                            |
| `2`  | **A safety guard tripped and needs a human**           | §8. Do not automate this away                   |
| `3`  | Another pass was already running; this one was skipped | Nothing, unless it persists                     |
| `4`  | Pass completed only partially                          | Usually self-healing. Investigate if it repeats |

### 7.2 The marker group

A completed pass updates one group called `agen-group-sync-status`. It has no members and no roles,
and the tool never includes it in a plan. Its metadata carries the time of the last completed pass,
a count of completed passes, and whether the last one was whole or partial.

It is written once per pass on purpose. Stamping every synced group every pass would produce a read,
an audit entry and several events per group — at a five-minute interval over fifty groups that is
roughly fourteen thousand writes a day, which buries the audit trail you would use to spot a
compromised credential.

### 7.3 What a healthy week looks like

- Exit code `0` on every scheduled pass
- The marker's pass count rising by one per pass
- Plans that are mostly zeroes, with small membership changes as people join and leave
- The same quarantined groups every pass, for reasons you have already decided to accept

---

## 8 · When it stops

**The most likely failure of this tool is not an error. It is quietly not running at all.** A
disabled schedule, a throttled runtime, an expired role, a rotated credential: none of these produce
an error for anyone to see.

> [!IMPORTANT]
> Alarm on the **absence** of a successful pass, not on the presence of errors. Concretely: alarm if
> the marker group's timestamp is older than three times your poll interval, and alarm separately on
> repeated exit code `1`, because a rotated credential otherwise freezes membership silently while
> everything looks healthy.

### 8.1 The safety guards

Before applying anything, the tool checks the whole plan. If any of these trip, it writes nothing,
exits `2`, and **stays tripped until you clear it**:

| Guard           | Trips when                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty-google`  | Google returned no groups at all. A failed scan is not an instruction to offboard everyone.                                                                                                                                                                                     |
| `no-candidates` | Google is healthy but nothing matched your prefix, while groups are already managed. This is prefix drift, and without the guard it would delete every synced group.                                                                                                            |
| `blast-radius`  | A pass would change more than `max(20%, 3)` of memberships, capped at `500` — measured **per group as well as per tenant**. Emptying a four-person group inside a forty-four-member tenant is 100% of that group and 9% of the tenant; a tenant-wide check alone cannot see it. |

It stays tripped on purpose. The condition that tripped it is usually still true, and silently
resuming next pass is how a mass revocation lands on the second attempt.

### 8.2 Clearing a tripped guard

```bash
# read the reason first — it tells you exactly what the plan wanted to do
node --env-file=.env dist/bin.js --clear-guard
```

Then dry run again and confirm the plan is what you intend before letting a real pass run. Do not
wire this into automation.

---

## 9 · Troubleshooting

| Symptom                                    | Cause and fix                                                                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Exit 1 at startup, a list of variables** | Configuration. Every problem is listed at once; fix them all and rerun. §4                                                                                                                         |
| `invalid_grant` from Google                | Domain-wide delegation is not authorised for this service account, or the impersonated subject is not a super-admin, or the two scopes in §3.1 were not added verbatim.                            |
| `unauthorized_client` from Google          | The client id in the Admin console delegation entry does not match the service account. Use the **numeric** client id, not the email.                                                              |
| **401 from Frontegg**                      | The API token was deleted or expired. Mint a new one. If it was rotated, an already-minted session stays valid until it expires.                                                                   |
| **403 on a specific action**               | A missing permission. Compare against the seven in §3.2 — the message names the action that failed.                                                                                                |
| **400 on user creation**                   | Almost always the missing application id. §4.1                                                                                                                                                     |
| **429 during a pass**                      | Rate limiting. The tool backs off and retries; a pass may end as exit `4` and finish next time. Persistent 429s mean your pass is too large — lower `SYNC_MAX_WRITES_PER_PASS` and run more often. |
| **Exit 3 every pass**                      | A stale lock, or genuinely overlapping passes. A lock older than thirty minutes is taken over automatically; if it persists, §6's caution applies.                                                 |
| **Exit 4 repeatedly**                      | The write budget is too small for your change volume, or an API call keeps failing. The message names which.                                                                                       |
| **A group you expected is not syncing**    | Its Google email does not start with your prefix, or it is quarantined. A dry run tells you which, and why.                                                                                        |
| **Plan wants to delete everything**        | Your prefix changed, or Google returned a partial read. The guards refuse this. Do not clear the guard until you know which.                                                                       |
| **Members missing from a synced group**    | They are nested groups, service accounts, or suspended users. All are reported as skipped in the pass summary rather than synced.                                                                  |

---

## 10 · Limits

Stated plainly, so you can decide what to rely on this for.

- **One machine at a time.** §6's caution. The lock is local.
- **Nested groups are not flattened.** Direct members only, with the rest reported.
- **No immediate revocation.** §2.1.
- **Policy-referenced groups are never deleted.** If Google drops a group that a live policy still
  targets, the tool quarantines it rather than orphaning your policy. You delete it by hand once the
  policy is updated.
- **Group membership is the entire scope.** It does not reconcile roles, policies, or users outside
  group membership.
- **SCIM overlap cannot always be detected.** Not every API response exposes whether a group is
  SCIM-managed. When that signal is absent the tool treats the group as unknown rather than as safe
  to write — but you should still avoid pointing this at a tenant where SCIM writes the same groups.
