# PWA-GoogleDrive v0.1.11 — Item 7D

- Isolate the established Ciyan partition codec, preserving its wire format and
  public imports. Share hashing and the existing transport/scheduler.
- Add an explicit JSON app-backup adapter with app/schema identity, deterministic
  partitioning, validation, bounded hash caching, complete download/repartition
  verification and explicitly guarded local restore callbacks.
- Require a matching codec for new app transport routes; avoid interpreting their
  fields as Ciyan data. Reject missing objects and unconfirmed generic commit receipts.
- Allow future app-specific profile status event and label without changing defaults.
- Document independent app backup eligibility, local transaction and conflict
  responsibilities, checkpoint size constraints, and explicit opt-in. No new app
  onboarding, profile schema changes, Worker changes, or release workflow changes.
- Keep PWA-Core pins explicit; existing Ciyan and AppLauncher reconciliation remains
  the only automatic shared Drive release path. Publish after 7C.
