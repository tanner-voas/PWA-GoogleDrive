# Profile authorization and data retention (v0.1.7)

## Account controls

- **Sign out on this device** removes that browser session and its cookie. Other authorized sessions, the encrypted refresh credential and all Drive files remain.
- **Revoke Google Drive access** requires typing `REVOKE`, calls Google's revocation endpoint, clears the account's stored refresh credential and in-memory access token, and invalidates every prior browser session with a new authorization epoch. No local IndexedDB data or Drive backups are deleted. Google revocation can affect all OAuth clients under the same Google Cloud project. A temporary failure is reported and does not claim success. If Google returns `invalid_token`, the stored authorization is removed but the UI distinguishes this from confirmed grant revocation. Use [Google Account connections](https://myaccount.google.com/connections) to independently verify or remove access. Reconnect with consent to resume backup.
- Sessions expire 14 days after login. Expired or invalidated records are removed on access or during subsequent login/revocation cleanup. Inactive accounts are not automatically erased by a calendar job. Refresh tokens are encrypted at rest with the deployment vault key and retained until revocation or operator-managed removal. Access tokens are held in memory until expiry or revocation.
- OAuth uses the narrow `drive.file` scope plus identity scopes, signed expiring state, S256 PKCE, and Secure/HttpOnly/SameSite cookies. Non-GET API requests require the CSRF header and reject conflicting Origin or cross-site fetch metadata. Existing sessions remain compatible. No new OAuth scopes or secrets are required.

## Backups

Drive snapshot content is JSON, not end-to-end encrypted; the service and your Google account can read it. The Azure credential envelope is encrypted separately by Ciyan. Imported reader text is opt-in. History retention is latest ten plus daily/weekly/monthly checkpoints, with opportunistic pruning and safe orphan collection. Signing out or revoking authorization does not erase backups. Delete backup files in Google Drive only after independently preserving needed data. Never include credentials or chapter text in diagnostic logs. The shared origin is a trust boundary for first-party launcher modules, not an isolation boundary for third-party code.

## Deployment checks

Deploy the profile Worker from main before relying on the new revoke control. Confirm Google Auth Platform → Audience is Production if long-lived refresh tokens are required; Testing mode can expire Drive-scope refresh tokens after seven days. Verify OAuth callback and login on both configured origins, then use a disposable account/profile to exercise sign-out and revocation across two browsers. Confirm that both sessions are invalidated, backup files remain and re-consent restores access. Never use your only active profile for destructive tests.
