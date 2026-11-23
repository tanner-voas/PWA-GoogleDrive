# PWA-GoogleDrive v0.1.6 — Recoverable profile metadata and cloud commits

- Invalid pre-existing profile metadata is preserved rather than replaced.
- An explicit recovery UI can propose profile IDs from locally discoverable
  IndexedDB databases; recovery requires typed confirmation and preserves the
  raw damaged metadata.
- Interrupted commits persist both operation ID and immutable revision ID for
  retry, avoiding duplicate manifests after lost responses.
- Retry of a revision whose content was staged before `head.json` was updated
  safely resumes that revision despite different wall-clock retry timestamps.
- A changed local revision receives a new pending revision ID.
- Retention pruning and garbage collection happen after commit acknowledgment,
  with maintenance timestamps persisted across Durable Object restarts.
- Optional user-imported reader text is stored per chapter in hashed sections,
  without changing how previous backup layouts are decoded.
