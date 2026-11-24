# App-owned backup adapters (Item 7D)

## Boundary and rollout

PWA-GoogleDrive owns the shared profile registry and selection, OAuth, session,
account-scoped Drive folders and content-addressed objects, revision/CAS transport,
retention, retry scheduling and content-free telemetry. PWA-Core remains independent
of cloud data. Application storage, schema validation, snapshot consistency, restore
transactions, fork copies, privacy choices and export formats belong to each app.

Ciyan is the only cloud-enabled application. Its existing codec is now explicitly
isolated in `src/ciyan-codec.js`; the original `sync.js` exports remain as compatible
entry points. Existing layouts, section names, serialized JSON bytes, hashes,
immutable dictionary cache, cursor keys, legacy database names and all Ciyan backup
operations are unchanged. `local-data.js` and Ciyan-specific registry recovery remain
legacy Ciyan helpers: no database renaming, generic IDB migration, new registry
schema or change to existing user data. The Worker and its routes are unchanged.

`src/app-backup.js` provides an explicit JSON adapter contract for future app
integrations. It does not enable WorldGen, Ascendant or any other app. No new UI,
cloud scope, credentials, profile switch behavior, or opt-in is introduced in them.
The shared profile's `remote` flag describes profile identity, **not proof that a
particular app has a cloud snapshot**. Each app must establish its own backup
eligibility and verify its own head; a remote profile with no app backup is not a
reason to initialize an empty local database or overwrite existing data.

## API

```js
import {createAppBackupAdapter} from './shared/google-drive/src/app-backup.js';

// Illustrative contract only: not an approved WorldGen/Ascendant backup format.
const adapter = createAppBackupAdapter({
  appId: 'example-app',         // lowercase worker path segment, not 'ciyan'
  format: 'example-backup',     // app-owned format identity
  version: 1,                  // app-owned schema version
  partition(state) {
    return {sections: {settings: state.settings, records: state.records},
            layout: {kind: 'example-v1'}};
  },
  assemble(sections, layout) {
    if (layout.kind !== 'example-v1') throw Error('Unsupported layout');
    return {settings: sections.settings, records: sections.records};
  },
  validate(state) {
    // Real applications must validate the entire schema, bounds and references.
    if (!state.settings || !Array.isArray(state.records)) throw Error('Bad state');
  },
  async readSnapshot({profileId}) {
    // App code: atomically read the durable data and its monotonically
    // increasing revision, scoped to this exact profile, never a global DB.
    return readDurableAppSnapshot(profileId); // {backup, revision}
  },
  async restore({profileId, backup, expectedRevision, revisionId}) {
    // App code: compare expectedRevision inside the same write transaction,
    // validate/stage all data and preserve a safety copy as appropriate.
    await atomicAppRestore(profileId, backup, expectedRevision, revisionId);
  }
});
```

The returned adapter is immutable and has the following operations:

- `codec.splitBackup(backup, {cache?})` / `codec.reconstructBackup(revision, entries)`:
  pure async codec functions; no network or local persistence. Backup envelope is
  `{format, version, appVersion, state}`. All callbacks may be async; validation
  throws or returns false for invalid data. Partition/assemble/validate must be
  deterministic and side-effect-free. Use stable section names and canonical
  application-defined field order; the codec sorts section keys, not nested
  keys. Only JSON values are accepted (no typed arrays, Dates, undefined, functions,
  nonfinite numbers, sparse arrays, cycles or reserved object keys). Convert binary
  data explicitly or design a separately reviewed binary format. Section names are
  safe IDs of 1–80 characters; each serialized section must be at most 16 MiB.
  Empty plans fail closed. The codec detaches the snapshot before awaiting,
  content-hashes sections, reuses equal serialized data with a bounded per-scheduler
  cache, and tags revision metadata with `{appId, schema:1}`. Restore requires an
  exact matching schema, all sections, app validation, and a lossless partition
  round trip. Existing Ciyan revisions have no such tag and are not rewritten.
- `startSync({profileId,onStatus,onDivergence})`: creates an ordinary isolated
  scheduler, with no request or upload until explicitly invoked by the app.
  Caller must first verify signed-in account, selected profile, app-specific opt-in
  and local/remote reconciliation. On a new verified local root, call `changed()`
  only after durable save; on boot compare local revision and persisted cursor and
  mark dirty if needed. `now()` when clean is a no-op, not evidence of an existing
  backup; `now({force:true})` explicitly checks remote state. Stop the old scheduler
  before changing profile or account, and wait for any in-flight save/commit before
  switching. No automatic fork or overwrite: `onDivergence` must implement the
  app's confirmed-conflict policy or surface the conflict for explicit resolution.
  An absent cursor is not proof that either copy is authoritative. Do not resolve
  a divergent head by guessing a new expected parent. Only a confirmed identical
  snapshot or successful guarded restore may establish a new cursor. The scheduler
  preserves pending operation/revision IDs, avoids false acknowledgement of newer
  edits, and retries transient failures with existing bounded backoff.
- `downloadRevision({profileId,revisionId?,onProgress?})`: fetches current head or
  explicitly selected historical revision via the existing scoped Worker paths,
  checks identity/schema, downloads checksum-verified objects, reconstructs, validates
  and repartitions to verify exact content. Returns `{revision,backup}` without local
  writes. Use this after initial upload to verify the full snapshot before marking
  an app as cloud-backed. Missing head is an error, not an empty backup.
- `restoreRevision({profileId,revisionId,expectedRevision,onProgress?})`: explicit
  historical restore only; requires a safe local revision number, and calls the app
  restore callback only after complete download/validation. The callback must compare
  the revision atomically at write time and reject concurrent changes, preserve local
  safety state, and return only when durable. A false return also rejects. This does
  not automatically upload the restored data, mutate the registry, promote a profile,
  or change its sync cursor. The app owns confirmation and subsequent sync decisions.

`sync.js` now accepts `{codec}` for `uploadBackup` and `downloadBackup` (fifth argument
for download, after progress callback), and `codec` for `createSyncScheduler`.
Without a codec the existing Ciyan route works exactly as before; other app IDs must
explicitly supply a matching codec. `splitBackup`, `reconstructBackup`, `checksum`,
`hex` and `createBackupCache` remain compatible exports for Ciyan. The generic path
checks exact commit acknowledgements, rejects unconfirmed revision-ID collisions and
verifies all returned objects before reconstruction. The Worker already verifies raw
object checksums; the new codec additionally verifies the re-encoded section hashes.

The existing profile UI accepts optional `adapter.appName` and `adapter.statusEvent`
for future app-specific wording and status updates. Defaults preserve Ciyan and
AppLauncher behavior. It still uses the existing single document-level controller.

## Before adding a new app (requires explicit approval)

- Decide which settings, projects, local saves, imported data and generated assets
  are backed up, which are excluded/device-only, and how the user opts in. No
  cross-app snapshot or export contract is introduced by this change.
- For WorldGen, assess checkpoint size, typed-array representation, stable project
  and checkpoint IDs, content-addressed partitioning, bounded memory and quota.
  The JSON adapter is deliberately not a streaming/binary checkpoint codec. Do not
  assume large worlds fit its current limits or silently truncate them. No legacy
  development save migration is implied.
- For Ascendant, define the actual saved project/encounter/settings scope and
  deterministic state validation independently of any WorldGen or Ciyan format.
- Define per-profile durable storage, atomic revision tokens, verified initial
  push, fork clone, cold-device restore and local-only workflow. Scope and UX need
  user approval before code is connected. Account-wide profile changes must not
  discard local app data or silently upload it.
- Test actual device/Drive restore, missing and corrupt objects, competing edits,
  lost acknowledgements, retention and data isolation under representative workloads.
  The current tests use synthetic adapters and simulated Drive storage, not actual
  WorldGen/Ascendant state or live user accounts.

## Dependency automation decision

Keep PWA-Core pins explicit. Separate consumer versions may coexist; there is no
need to introduce new repository dispatch tokens, automatic fan-out, or a common
Core deployment. Existing PWA-GoogleDrive release tests notify Ciyan once, Ciyan's
serialized updater pins latest main and notifies the existing AppLauncher
coordinator, which reconciles and tests all pinned apps and advances main and
production only after a successful strict release gate. The launcher shared Drive
pin must match Ciyan's. Tags remain source-history labels. No changes to the Worker,
Cloudflare binding, workflows, secrets, or production exception in 7D.

Publish 7C first: its binding script expects the reviewed 7B consumer parents.
Publishing this library first could cause Ciyan's dependency-update bot to move main
and invalidate that preflight. Then publish this single library patch with gamp and
let existing release automation reconcile pins. Do not manually push production.
A concurrent non-fast-forward Ciyan pin update fails safely rather than forcing a
push; rerun its existing `Update PWA Google Drive submodule` workflow if needed.
The AppLauncher scheduled reconciler cannot advance an unaligned Ciyan Drive pin by
itself. Verify all three workflows and exact deployed dependency pins before
considering release complete. Core auto-propagation is deferred rather than adding
an unneeded dispatch cascade; reconsider only if repeated manual pinning warrants it.
