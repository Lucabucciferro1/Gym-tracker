# Forge gym tracker

Forge is a private, full-stack gym progress journal for a small group of friends. It combines body measurements and max-lift charts with weekly workout and meal planning, selective progress sharing, invitation-based accounts, and a server-enforced admin area.

## Run locally

Requirements: Node.js 24.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. On the first visit, Forge asks you to create the administrator account. Its username starts as `Admin`, but you can choose another name before setup and rename it later from account settings. No default password or credentials are stored in the repository.

The development command starts:

- the React app at `http://localhost:5173`
- the API at `http://localhost:3001`

Data is stored locally in `data/forge.db`. That directory is ignored by Git.

## Production build

```bash
npm ci
npm run build
npm start
```

The server serves the compiled app from `dist/`. It uses the `PORT` environment variable, or port `3001` locally.

Copy `.env.example` to `.env` if you want to change the local database path or session settings. Environment files, database files, password hashes, and session tokens must not be committed.

## Deploy on Render

This repository includes a root `render.yaml` Blueprint. It builds the React client, starts the Node server, checks `/api/health`, enables secure cookies behind Render's proxy, and stores SQLite at `/var/data/forge.db` on a persistent disk. Automatic deploys wait for the linked GitHub checks to pass.

1. Create a GitHub repository and push this project to it.
2. In Render, choose **New > Blueprint** and connect the GitHub repository.
3. Review the Blueprint, then create the `forge-gym-tracker` service.
4. Open the deployed URL and create the administrator account immediately.

The Blueprint intentionally uses Render's paid `starter` plan because Render does not allow persistent disks on free web services. A free web service would lose the local SQLite database during restarts, redeploys, or spin-downs. Do not remove the disk or change `DATABASE_PATH` away from `/var/data/forge.db` unless you also move Forge to a durable external database.

Render supplies `PORT`; it should not be added manually. The service is configured for Node 24 in `.node-version`, `package.json`, and `render.yaml`.

## GitHub checks

The workflow in `.github/workflows/ci.yml` runs on pushes and pull requests. It installs the locked dependencies with `npm ci`, then runs the TypeScript checks, automated tests, and production build on Node 24.

The repository ignores local dependencies, compiled output, environment files, SQLite files, logs, and test coverage. Before pushing, check the staged file list and make sure no `.env` or database file is included.

## What is included

- Secure first-run administrator setup and sign-in with HTTP-only sessions
- One-time account invitations: the administrator creates a username, shares the generated code, and the friend chooses their own password on first sign-in
- Custom measurement types and dated measurement history, with saved drag-and-drop ordering
- Custom exercises, max-lift history, estimated one-rep max values, and saved drag-and-drop ordering
- Responsive progress charts with date-range filtering
- Editing, deletion, notes, and unit-aware records
- A customizable seven-day workout plan with named sessions, exercises, notes, and explicit rest days
- A seven-day meal plan with optional calories, macro targets, and independently switchable calorie/macro displays
- Read-only friend sharing with separate permissions for measurements, lifts, workouts, and meals; access can be changed or revoked at any time
- Role-protected account administration, including user disabling, deletion, and invitation reset
- Account username and password changes, plus private data export as JSON
- Server-side validation, ownership checks, password hashing, rate limiting, and security headers

## Invite a friend

1. Sign in with the administrator account and open **Admin**.
2. Choose **Add user**, enter a username, and create the account.
3. Copy the one-time invite code immediately; only its hash is stored, so the code cannot be shown again.
4. The friend opens the sign-in page, chooses **Activate with an invite code**, enters the username and code, and creates a password.

If the code is lost or an account needs to be recovered, the administrator can issue a new invitation from the user menu. Doing so invalidates the old password, invite code, and active sessions for that account.

## Commands

```bash
npm run dev       # start the API and Vite development server
npm run build     # type-check and build the client
npm run typecheck # run TypeScript checks only
npm test          # run the automated test suite
npm start         # run the built application
```

## Security and backups

Admin access is based on the persisted account role and is checked on every admin API route. It is not granted by a client-side username check. Users can only mutate records belonging to their own account. Friend data is exposed only through explicit, read-only sharing grants, with each shared section enforced by the server.

For any internet-facing deployment, keep HTTPS and secure cookies enabled, use a strong administrator password, and back up the persistent SQLite database regularly. The included Render Blueprint sets `COOKIE_SECURE=1` and `TRUST_PROXY=1`; the local `.env.example` keeps secure cookies off so plain HTTP development continues to work.
