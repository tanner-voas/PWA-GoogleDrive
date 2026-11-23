# PWA-GoogleDrive v0.1.1

Shared **local-first profile management** and Google Drive backup/synchronization for AppLauncher and Ciyan. Submodule: `shared/google-drive` in both repos.

## Components

- `src/profiles.js`: stable local UUID registry, cloud metadata, OAuth entrypoints.
- `src/local-data.js`: complete Ciyan IndexedDB clone for independent profiles.
- `src/sync.js`: bounded debounce, retry-safe commit IDs, content-addressed backup partitions and recovery.
- `src/ui.js`: shared profile menu; app host provides data-specific hooks.
- `src/retention.js`: rolling retention policy, validation.
- `worker/index.js`: secure same-origin OAuth and Google Drive API proxy, Durable Object serialization.
- `.github/workflows/release.yml`: sends **one** Ciyan update event; Ciyan alone requests coordinated AppLauncher pin update.

## Cloud rules

- No Google tokens in browser storage or exported profiles. The Worker encrypts refresh tokens in Durable Object storage. PIN-encrypted Ciyan secrets remain PIN-protected; the Google login does not unlock them.
- Visible Google Drive folder: `AppLauncher Profiles`. Profiles are uniquely identified by UUID even when names collide.
- Ciyan writes locally immediately; cloud uploads follow settled edits; a failed upload never changes local data.
- Uploads are immutable content chunks + revision manifests; `head.json` changes only after all data is present. Operations are idempotent by operation ID.
- Different committed parent revisions return HTTP 409. The client verifies remote head before any fork. Network/auth errors alone never fork.
- Rolling retained manifests: 10 recent, one/day (14 days), one/week (12 weeks), one/month (12 months). Objects are garbage-collected no sooner than seven days after creation, only after checking retained heads and revision manifests across ALL profiles. Failed scans delete nothing.

## Deployment

See `SETUP.md` for full creation/deployment and the per-repo `gamp` order. Both AppLauncher and standalone Ciyan must use Workers in the same Cloudflare account to enable same-origin Worker service bindings.

## Known constraints for the initial release

- There is no always-running iOS background sync: the PWA uploads while active and when it next resumes. Sudden iOS suspension can delay a pending sync; local IndexedDB writes remain durable.
- Each website origin has its own local profile selection. Hosted Ciyan and AppLauncher are truly shared; standalone Ciyan can select the same cloud profile after independently connecting.
- User-visible revision history and manual recovery are supported in Ciyan; no automatic merging of divergent learning histories.
- The first local profile retains Ciyan's legacy database, with its contents unchanged. All subsequent profiles use independent IndexedDB databases.
- On an unrecognized local/cloud state without common sync history the app halts syncing rather than guessing.
- Full-account mark-and-sweep runs opportunistically after commits; Cloudflare/Drive outages can delay reclamation.
