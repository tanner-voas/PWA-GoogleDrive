# v0.1.10 — account-wide network telemetry

Adds bounded, profile-independent performance telemetry to the existing cloud synchronization service. Server request and commit-stage timing, maintenance duration, and client backup diagnostics are collected without adding a Drive write to each foreground backup. Durable alarm-driven batches are stored in the connected user's Drive, separately from backup revisions. Existing recovery and data formats remain unchanged. See `NETWORK_TELEMETRY.md` for privacy, retention, export, and failure behavior.
