# Local Next.js example

Two fake SaaS products demonstrate the same SDK with different capabilities and separate credentials, data, and replay stores. This application exposes API routes only.

## Run it

Use Node.js 22.13+ and npm. Run these commands from the repository root:

```bash
npm install
npm run example:setup
npm run example:dev
```

`example:setup` writes `.env.local` in this directory with separate random secrets for Product A and Product B. The file is ignored by Git and is created with owner-only permissions. Running setup again preserves the existing file. Do not commit or share it.

The server listens on `http://127.0.0.1:3001`. Keep it running and, in a second terminal at the repository root, run:

```bash
npm run smoke
```

The smoke command prints a checklist and exits successfully only after the full flow passes. It discovers capabilities, searches the same email in both products, checks user lookup, bans and unbans Product A's user, revokes sessions, changes the plan, and invokes `grant-free-pro`. It verifies Product B stays unchanged and rejects mutations it has not registered.

Security checks cover a modified signature, an expired request, a replay, and credentials sent to the wrong product. A temporary loopback fixture drops connections to test an unavailable product while Product A remains responsive; it does not stop the development server.

The script restores Product A's original ban status and plan. Session revocation persists, and restoring the plan clears a complimentary subscription's expiry. Repeated runs are supported. Restart the example to restore all initial fixture data.

## Products and routes

| Product   | Endpoint                 | Registered operations                                              |
| --------- | ------------------------ | ------------------------------------------------------------------ |
| Product A | `/api/yanvah-control`    | Discovery, all users and subscription operations, `grant-free-pro` |
| Product B | `/api/secondary-control` | Discovery, user search/lookup, subscription lookup                 |

Both products initially contain `john@example.com` (`user_123`) and `alex@example.com` (`user_456`). Each user is unbanned, has two fake sessions, and has an active `basic` subscription with no period end.

[`app/api/yanvah-control/route.ts`](./app/api/yanvah-control/route.ts) directly exports the standard SDK handler as `POST`, using the Node.js runtime. [`lib/product.ts`](./lib/product.ts) supplies the fake business functions and explicit registrations; [`lib/products.ts`](./lib/products.ts) configures the two independent products. The [second route](./app/api/secondary-control/route.ts) uses the same integration with read-only registration. Adding it requires no SDK changes.

The `grant-free-pro` action is explicitly marked `dangerous`. Its Zod schema accepts `{ userId, days }`, with an integer duration of 1–365 days. It changes that user's subscription to `pro` and returns the user ID, plan, duration, and period end. This is fixture logic; the application remains responsible for its own authorization and subscription rules.

## Configuration and development

The server and smoke script read these server-only values from `.env.local`:

| Product | Key ID             | Secret             |
| ------- | ------------------ | ------------------ |
| A       | `PRODUCT_A_KEY_ID` | `PRODUCT_A_SECRET` |
| B       | `PRODUCT_B_KEY_ID` | `PRODUCT_B_SECRET` |

The example imports the SDK through its built public package exports. `example:dev` builds the SDK before starting Next.js. After changing SDK source, restart that command to rebuild it. Next.js reloads changes inside the example automatically. Next.js telemetry is disabled by the repository's launcher.

Stop the development server before running `npm run typecheck` or `npm run build`. The launcher regenerates Next.js route types for the selected mode and removes the other mode's stale generated types to avoid an [upstream duplicate-declaration issue](https://github.com/vercel/next.js/issues/91895). Strict declaration checking remains enabled.

Run `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build` from the root to validate changes. Type checking and building include the example. The test suite starts an isolated Next.js server on an available loopback port and runs the same two-product flow without external services.

The example's development-only `@typescript/lib-dom` alias uses the official `@types/web` declarations required by Next.js's current types. The SDK retains TypeScript's bundled platform declarations.

If the example reports missing credentials, run `npm run example:setup` from the root. If `.env.local` already exists, ensure it contains all four values. If port 3001 is occupied, stop the process using that port before starting `example:dev`. A browser GET does not invoke an operation: use the signed client or smoke command.

## Memory and deployment limits

Users, subscriptions, sessions, and replay records live in this process. A restart or development module reload can reset them. This is a single-process local demonstration.

Production endpoints require HTTPS and separate secrets for every connection. Distributed or serverless deployments require a shared `ReplayStore` that atomically claims request IDs; an in-memory store cannot protect across instances or restarts. Preserve the request body for signature verification instead of parsing it before calling the handler. See the [protocol](../../docs/PROTOCOL.md) and [threat model](../../docs/THREAT_MODEL.md) for the full deployment contract.
