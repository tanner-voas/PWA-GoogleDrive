# Full installation and setup — PWA-GoogleDrive v0.1.0

**Baseline:** AppLauncher v0.1.6 → v0.1.7 and Ciyan v0.9.6 (Unified Header release) → v0.9.7. This does **not** apply on top of the deferred Ciyan v0.9.6 Google Drive prototype. The original Google Drive branch remains separate.

## 0. Prerequisites and safety

Keep a complete Ciyan JSON export in iPhone Files first, with the file present and checked. The app continues to use its original `ciyan-mandarin` IndexedDB for the initial Default profile and the new release must not silently reset that database.

The entire system requires the existing AppLauncher and standalone Ciyan Cloudflare Workers to be in the **same Cloudflare account**, because both use a Worker service binding named `PROFILES` to `pwa-profiles-api`. Profile selection is shared between AppLauncher and hosted Ciyan because those pages have the same origin. Standalone Ciyan lives under a different origin; connect to the same Google account and choose the same cloud profile there.

Your `gamp` alias should stop on errors. Recommended iSH definition:

```sh
alias gamp='git am -- *.patch && git push && rm -f -- *.patch'
```

If your shell does not support `git am -- *.patch`, use `git am ./*.patch && git push && rm -f ./*.patch`. Only copy the patch for the current repository into the directory before invoking it. A patch must never be removed if `git am` or `git push` fails.

## 1. Create the new GitHub repository

The connected GitHub interface currently does **not** permit creating repositories. Create it manually at https://github.com/new:

- Owner: `tanner-voas`
- Repository name: **`PWA-GoogleDrive`**
- Prefer private if you do not want the implementation visible; ensure GitHub Actions/submodule clones have permission if private. Public is simpler for the existing unauthenticated submodule checkout workflows.
- Initialize with **no** README, `.gitignore`, or license (the downloaded bundle already has Git history and these files).

Extract the supplied `PWA-GoogleDrive_v0.1.0.zip` into your iSH working folder, e.g. `/mnt/wcopy/apps/PWA-GoogleDrive`, preserving the `.git` directory.

```sh
cd /mnt/wcopy/apps/PWA-GoogleDrive
git status -sb
git remote -v
# Push only after configuring the CIYAN_DISPATCH_TOKEN secret (section 2).
git push -u origin main
```

**Important:** The Ciyan and AppLauncher patches contain a Git submodule pointer to the **exact commit** in this new repository. Do not amend, rebase, or recreate that initial commit before pushing it. If you do, the patches will point at a commit GitHub does not have.

## 2. Configure the GitHub Actions dispatch secrets

Create a fine-grained Personal Access Token via GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens. Restrict it to `tanner-voas/Ciyan`, set **Contents: Read and write** (used for repository dispatch). Give it a short descriptive name and a sensible expiration. Store it in the new PWA-GoogleDrive GitHub repository → Settings → Secrets and variables → Actions → New repository secret:

- `CIYAN_DISPATCH_TOKEN` — GitHub token with Ciyan Contents write.

Ciyan already uses `APP_LAUNCHER_DISPATCH_TOKEN` for ordinary Ciyan → AppLauncher notifications. Verify this secret is present in **Ciyan** repository Actions secrets. If not, create another fine-grained GitHub token restricted to **AppLauncher** with Contents Read and write, and store it under that name in Ciyan.

For Ciyan and AppLauncher, check Settings → Actions → General → Workflow permissions: **Read and write permissions** (or use per-workflow `contents: write` where allowed). Ensure branch protection does not block your intended bot push to `main`.

The workflows are deliberately one-directional:

1. PWA-GoogleDrive release Action dispatches `google-drive-release` to Ciyan.
2. Ciyan's `update-google-drive.yml` pins its shared submodule, tests the library, pushes its commit with its default GITHUB_TOKEN, **then explicitly dispatches** `ciyan-updated` to AppLauncher. This explicit dispatch is needed because GitHub suppresses many workflow runs induced by `GITHUB_TOKEN` pushes.
3. AppLauncher's `update-ciyan.yml` pins latest Ciyan **and** Ciyan's exact GoogleDrive submodule commit in **one** AppLauncher commit. AppLauncher is the sole automated writer of its own pins; its concurrent update jobs serialize.
4. Regular hand-pushed Ciyan commits use the existing notification workflow; AppLauncher still uses the same coordinator. If the GitHub Actions job finishes before another concurrent repo edit, re-run the AppLauncher coordinator via Actions → Update Ciyan and shared Google Drive pointers → Run workflow.

**Do not configure an additional direct PWA-GoogleDrive → AppLauncher write workflow.** That would create the race you wanted to avoid.

## 3. Google Cloud project and OAuth

1. Go to https://console.cloud.google.com/ . Select or create a project (e.g. `PWA Profiles`).
2. Under APIs & Services → Library, enable **Google Drive API**.
3. Under Google Auth Platform / OAuth consent screen, configure Branding, Audience, and Data Access. User type should be External for a personal Gmail account. Add your own Google address as a test user if the app is in Testing status.
4. Scopes for OAuth: `openid`, `email`, `https://www.googleapis.com/auth/drive.file`. `drive.file` deliberately only covers Drive files created/selected by the app; no full-Drive permission required.
5. Create an **OAuth client ID → Web application**. Register the exact authorized redirect URIs, using your actual Workers hostnames:

   `https://applauncher.<YOUR_SUBDOMAIN>.workers.dev/_profiles/v1/auth/callback`

   `https://ciyan.<YOUR_SUBDOMAIN>.workers.dev/_profiles/v1/auth/callback`

   If you use custom domains, also register the exact custom-domain callback URLs and use those origins in ALLOWED_ORIGINS.
6. Save the **Client ID** and **Client Secret**. The client secret belongs only in the Cloudflare Worker secret store, never in the Git repository or browser.
7. For long-lived refresh tokens, publish the OAuth consent screen to **In production** when your setup allows it. Google OAuth External **Testing** refresh tokens normally expire after seven days for these scopes. A personal limited-audience production app may show an unverified-app warning; review the OAuth policies before continuing.

## 4. Deploy the Cloudflare authentication/storage Worker

Change `ALLOWED_ORIGINS` in the new repo's `wrangler.jsonc` to exactly your deployment origins, separated by commas, without trailing slashes. This file contains **origins only**, not credentials.

```sh
cd /mnt/wcopy/apps/PWA-GoogleDrive
npx --yes wrangler@4 login
npx --yes wrangler@4 secret put GOOGLE_CLIENT_ID
npx --yes wrangler@4 secret put GOOGLE_CLIENT_SECRET
openssl rand -base64 48 | tr -d '\n' | npx --yes wrangler@4 secret put SESSION_SIGNING_KEY
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' | npx --yes wrangler@4 secret put VAULT_KEY
npx --yes wrangler@4 deploy
```

If Wrangler asks you to deploy first before accepting secrets, deploy once, then set the secrets and deploy again. Worker name must be **`pwa-profiles-api`**. It creates a SQLite Durable Object binding named `ACCOUNTS` via the included migration; Google refresh tokens are encrypted before storage. Check Cloudflare Workers & Pages → `pwa-profiles-api` → Bindings/Secrets. None of the secret values should appear in source control.

A browser direct request to the worker's `workers.dev` host is not the intended UI entrypoint. Requests go through `/_profiles/v1` on AppLauncher or standalone Ciyan, proxied using their `PROFILES` service bindings.

## 5. Apply the patches in your repositories

Do this **after** the new GitHub repository exists and its initial commit is pushed. Begin with a clean Ciyan v0.9.6 Unified Header and AppLauncher v0.1.6 Unified Header. Do not combine with the old Google Drive v0.9.6 patch.

First AppLauncher, before the automatic Ciyan update can race its main branch:

```sh
cd /mnt/wcopy/apps/AppLauncher
git checkout main && git pull --ff-only
# Copy AppLauncher_v0.1.7_Profiles.patch into this folder
gamp
```

Then Ciyan:

```sh
cd /mnt/wcopy/apps/Ciyan
git checkout main && git pull --ff-only
# Copy Ciyan_v0.9.7_Profiles.patch into this folder
gamp
```

If `git am` reports a mismatch, stop; don't use `git reset --hard` or force-push. Confirm you're on the intended previous version, `git am --abort` if required, and investigate the mismatch.

Submodule pointers in these patches are pinned to the first PWA-GoogleDrive commit you pushed. For a local build:

```sh
cd /mnt/wcopy/apps/Ciyan
git submodule sync --recursive
git submodule update --init --recursive
npm test
python3 package.py

cd /mnt/wcopy/apps/AppLauncher
git pull --ff-only  # may have been advanced by the Ciyan dispatch action
git submodule sync --recursive
git submodule update --init --recursive
npm test
python3 build.py
```

Verify all three app tiles still build (not just the launcher). Keep app submodule pointers exactly as managed by the coordinator; ordinary Ciyan changes do not need manual updates to the shared pin in AppLauncher.

## 6. Cloudflare deployment integration

The AppLauncher and standalone Ciyan patches change their `wrangler.jsonc` to include a `main` Worker entrypoint, an `ASSETS` binding, and a `PROFILES` service binding to **`pwa-profiles-api`**. The Worker routes profile API requests to the service and serves all normal PWA assets with `env.ASSETS.fetch(request)`. Both service worker cache templates explicitly skip `/_profiles/` requests.

Deploy or let your existing GitHub → Cloudflare Worker builds deploy each app after the patch push. Service bindings require the auth Worker to be in the same Cloudflare account and already deployed. In the Cloudflare dashboard, confirm both workers have service binding `PROFILES → pwa-profiles-api`.

## 7. Functional smoke test (use a disposable test profile first)

1. Open AppLauncher on the iPhone. Tap the new profile icon immediately before Refresh. Ensure **Default** is listed and local content still opens.
2. Tap Connect Google Drive and complete the Google account consent flow. You should return to AppLauncher and see the profile selection menu. An empty account will initially list no remote profiles.
3. Select **Add current profile to Google Drive**. Its profile ID and name will be created under **My Drive / AppLauncher Profiles**.
4. Open Ciyan from AppLauncher. Ciyan should use exactly the same current profile ID and authorization session without an additional login. Open Archive → Sync to Google Drive now. Confirm the cloud revision and view history under Archive.
5. In Google Drive, check the visible profile folder and content-addressed object files. Do not manually edit `head.json` or chunk files.
6. Review one study word. The answer should save immediately to IndexedDB. After a short debounce the backup indicator should move from red to yellow while uploading, then green upon confirmed success. If upload fails, the local data must remain intact.
7. Fork the current profile, name it `Test Fork`, switch and confirm it starts with identical learning history and dictionary; then change one setting and verify the original profile is unchanged.
8. Disconnect Google Drive. Changes should still save locally. Reconnect, select that profile again, and verify it uploads changed sections.
9. Test restoring a prior version only after exporting a separate JSON backup. Restoring should create a safety fork, reload the selected full state, and sync it as a new revision. PIN-encrypted speech credentials should require the existing PIN to unlock.
10. Test standalone Ciyan independently: its browser session may need another Google sign-in due to the different hostname. Choose the same cloud profile; it should download that profile's Ciyan data instead of creating an empty one.

## 8. Troubleshooting

- **OAuth `redirect_uri_mismatch`:** The actual hostname, scheme, and callback route must exactly match one registered in Google Cloud.
- **Google sign-in expires after one week:** External OAuth consent screen is probably still in Testing status.
- **503 profile binding missing:** The `pwa-profiles-api` Worker is not deployed in the same Cloudflare account or the app's service binding is missing.
- **403 origin not configured:** Add both live origins to ALLOWED_ORIGINS in the shared Worker's `wrangler.jsonc`, redeploy.
- **CI action fails with authentication:** Check `CIYAN_DISPATCH_TOKEN`, `APP_LAUNCHER_DISPATCH_TOKEN`, Actions workflow permissions, branch protection.
- **AppLauncher action runs twice:** Normal dispatch notifications can overlap. Concurrency and idempotent checks should yield at most one effective update. Do not add an extra independent updater.
- **Google Drive outage / weak mobile connectivity:** Do not create a new profile; leave Ciyan open offline. Pending unsynced data stays local and is retried when the app runs again.
- **Unknown local/cloud lineage:** The client refuses a destructive guess. Preserve a JSON export and deliberately select/upload the intended source; a transient error must never automatically fork.
- **Missing `shared/google-drive` submodule during build:** Re-run `git submodule sync --recursive && git submodule update --init --recursive` after the initial shared repo has been created and pushed.

## 9. Limits and release caveats

This is source-level tested but **not yet tested with a real Google OAuth client, Cloudflare deployment, or an iPhone** in the current environment. The service bindings, Workers build behavior, cookie handling across OAuth redirects, and recovery paths must be checked with the smoke test before you rely on cloud-only recovery. Keep manual Ciyan JSON exports until that passes. Background sync on a closed iPhone PWA is not guaranteed.
