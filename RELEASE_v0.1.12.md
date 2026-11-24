# PWA-GoogleDrive v0.1.12

Permit the standalone Git Manager origin `https://pwa-git-api.tannervoas.workers.dev` through the existing profile Worker. No authorization scope, backup format, session logic or other API behavior changes. Keep the current launcher and Ciyan origins. The administrator must also add `https://pwa-git-api.tannervoas.workers.dev/_profiles/v1/auth/callback` to the existing Google OAuth web client's authorized redirect URIs. Existing automatic Ciyan/launcher dependency reconciliation remains responsible for pin propagation.
