# Yanvah Control SDK

Securely connect a SaaS application to a self-hosted Yanvah Control instance.

> **Status:** `0.2.0` is prepared for release review and has not been published by this repository setup. See the [release checklist](https://github.com/yanvah/control-sdk/blob/main/docs/RELEASING.md) for required account configuration and the explicit publishing step.

## What it does

`@yanvah/control` provides the shared protocol, signed HTTP client, and secure request handler between:

- **Yanvah Control**, the self-hosted administration dashboard
- **A connected SaaS**, which explicitly exposes supported administrative operations

```mermaid
flowchart LR
    A[Yanvah Control] -->|Signed HTTPS request| B[Control endpoint in SaaS]
    B --> C[@yanvah/control]
    C -->|Validated operation| D[SaaS business logic]
    D --> E[Application services and database]
```

A connected SaaS remains responsible for its own data and business logic. Yanvah Control does not receive direct database access.

The handler authenticates the exact request bytes, rejects stale or replayed requests, validates operation input, and calls only registered functions. See [`docs/PROTOCOL.md`](./docs/PROTOCOL.md) for the wire contract and server configuration, and [`docs/THREAT_MODEL.md`](./docs/THREAT_MODEL.md) for trust boundaries and deployment responsibilities.

## Capabilities

The SDK supports:

- Capability discovery
- User search and inspection
- Opt-in user creation in protocol v2
- Ban and unban operations
- Session revocation
- Subscription lookup and plan changes
- Explicitly registered product-specific actions
- Signed requests, timestamp validation, and replay protection
- A typed client for the Yanvah Control server

## What this package is not

This repository does not contain:

- The Yanvah Control dashboard
- React components or Refine
- A database or ORM
- Direct database introspection
- Stripe, Clerk, PostHog, or Sentry integrations
- Arbitrary SQL, JavaScript, shell, or HTTP execution
- A hosted relay or cloud service

The self-hosted dashboard lives in the separate [`yanvah/control`](https://github.com/yanvah/control) repository.

## Package surface

```text
@yanvah/control
@yanvah/control/server
@yanvah/control/client
```

The core SDK is framework-independent and uses standard `Request`, `Response`, and `fetch` APIs on Node.js 22+.

The root exports protocol constants, normalized error codes, shared types, and public Zod schemas. `/server` exports `createControlHandler`, `createMemoryReplayStore`, and their types. `/client` exports `createControlClient`, `ControlClientError`, and client types. Cryptographic helpers are internal.

## Run the local example

From the repository root, using Node.js 22.13+ and npm:

```bash
npm install
npm run example:setup
npm run example:dev
```

Setup creates an ignored `examples/nextjs/.env.local` with separate random credentials for two fake SaaS products. It does not overwrite existing credentials. The Next.js server listens on `127.0.0.1:3001`; leave it running and run this in another terminal:

```bash
npm run smoke
```

The smoke script acts as the Control server: it discovers both products, searches the same email, exercises Product A's mutations and custom action, and verifies Product B stays unchanged. It also checks signature, expiry, replay, and unavailable-product failures. All requests use the SDK's signed protocol, including local requests.

Product A exposes all MVP operations at `/api/yanvah-control`. Product B exposes only discovery, user search/lookup, and subscription lookup at `/api/secondary-control`. Both start with `john@example.com` (`user_123`), an unbanned user on the `basic` plan. There is no browser UI. See the [example guide](./examples/nextjs/README.md) for route code, fixture behavior, and troubleshooting.

## Five-minute Next.js integration

In a Next.js App Router application running Node.js 22+, install:

```bash
npm install @yanvah/control@0.2.0 zod
```

Before the first npm release, build a local tarball with `npm install && npm run build:sdk && npm pack` in this repository, then install its absolute path in your application instead: `npm install /absolute/path/yanvah-control-0.2.0.tgz zod`.

For a new local integration, generate credentials without printing them. This creates `.env.local` with owner-only permissions and refuses to overwrite an existing file. If that file already exists, add the same variable names using fresh credentials from your secret manager instead. Keep `.env.local` out of version control.

```bash
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
writeFileSync('.env.local', [
  'YANVAH_CONTROL_KEY_ID=local-saas',
  `YANVAH_CONTROL_SECRET=${randomBytes(32).toString('hex')}`,
  'PRODUCT_ENDPOINT=http://127.0.0.1:3000/api/yanvah-control',
  '',
].join('\n'), { flag: 'wx', mode: 0o600 });
JS
```

Create `app/api/yanvah-control/route.ts` (or `src/app/api/yanvah-control/route.ts`):

<!-- quickstart-route -->

```ts
import { z } from "zod";
import {
  createControlHandler,
  createMemoryReplayStore,
  ControlHandlerError,
} from "@yanvah/control/server";
import type { User } from "@yanvah/control";

export const runtime = "nodejs";

const keyId = process.env.YANVAH_CONTROL_KEY_ID;
const secret = process.env.YANVAH_CONTROL_SECRET;
if (!keyId || !secret)
  throw new Error("Missing Control connection credentials.");

const users: User[] = [{ id: "user_123", email: "john@example.com" }];

export const POST = createControlHandler({
  product: { id: "example-saas", name: "Example SaaS" },
  auth: { keyId, secret },
  replayStore: createMemoryReplayStore(),
  users: {
    create: ({ email, name }) => {
      if (
        users.some((user) => user.email?.toLowerCase() === email.toLowerCase())
      )
        throw new ControlHandlerError("USER_ALREADY_EXISTS");
      const user = {
        id: `user_${users.length + 1}`,
        email,
        ...(name ? { name } : {}),
      };
      users.push(user);
      return user;
    },
    search: ({ query, limit }) =>
      users.filter((user) => user.email?.includes(query)).slice(0, limit),
    get: ({ userId }) => users.find((user) => user.id === userId) ?? null,
  },
  actions: {
    "count-matches": {
      label: "Count matching users",
      description: "Count users whose email contains the query.",
      risk: "safe",
      input: z.strictObject({ query: z.string().min(1).max(256) }),
      run: ({ query }) => ({
        count: users.filter((user) => user.email?.includes(query)).length,
      }),
    },
  },
});
```

<!-- /quickstart-route -->

Start your application with `npm run dev -- --hostname 127.0.0.1 --port 3000`. Save the [client example below](#client-usage) as `scripts/control-smoke.mts`, then run it in another terminal (Node.js 22.13+ for native TypeScript execution):

```bash
node --env-file=.env.local --experimental-strip-types scripts/control-smoke.mts
```

It prints `Example SaaS 1` after signed discovery and search. The route's users are fixtures; replace the callbacks with your application's business functions. This process-local replay store is for the local example: [production deployments](./docs/DEPLOYMENT.md) need HTTPS, protected credentials, and replay storage appropriate to their workers and restart behavior.

### Registering operations

Register `ban`, `unban`, or `revokeSessions` explicitly to enable those mutations. Their callbacks may return void; successful wire responses contain `data: null`. `search` returns a `User[]`; `get` returns a matching `User` or `null`. Returned data is validated, so map service/database records to the documented user model. Unregistered operations are unavailable and are not advertised by capability discovery.

Register `create` to enable protocol v2 user creation. It receives `{ email, name? }` and returns the created `User`. The SaaS owns invitations, credentials, and account defaults. Throw `ControlHandlerError("USER_ALREADY_EXISTS")` only when no account was created; other exceptions receive a sanitized `INTERNAL_ERROR` response.

Register `subscriptions.get({ userId })` to return a matching `Subscription` or `null`, and `subscriptions.changePlan({ userId, planId })` for a void-returning plan change. Custom actions require an explicit ID, label, description, risk, and `run` callback. The optional Zod `input` schema validates the action's payload and infers the callback input type. Without a schema, input is a validated `JsonValue`. Actions must return JSON-compatible data, including `null` when there is no result. Discovery includes action metadata, not executable schemas.

Each callback also receives `{ requestId, actor, signal }` as a second argument. `actor` is caller-supplied audit attribution, not authorization. Pass `signal` to cancellable downstream work. The default request deadline is 10 seconds; timing out cannot roll back a mutation or forcibly stop a callback that ignores cancellation.

Generate a different random secret for each connection and store it in your secret manager. The SDK treats the configured value as literal UTF-8 text and requires 32–1024 bytes. Serve the endpoint over HTTPS in production; local requests must also be signed.

The example's replay store is process-local and loses its state on restart. Distributed and serverless deployments need a shared implementation of `ReplayStore` that atomically claims each ID until its expiry. Use one store namespace per product connection. The in-memory store rejects new claims when its capacity is full instead of evicting live replay records.

## Client usage

Run the client on the trusted Control server, where connection credentials are stored:

<!-- quickstart-client -->

```ts
import {
  ControlClientError,
  createControlClient,
} from "@yanvah/control/client";

const endpoint = process.env.PRODUCT_ENDPOINT;
const keyId = process.env.YANVAH_CONTROL_KEY_ID;
const secret = process.env.YANVAH_CONTROL_SECRET;
if (!endpoint || !keyId || !secret)
  throw new Error("Missing product connection configuration.");

const client = createControlClient({
  endpoint,
  keyId,
  secret,
  timeoutMs: 10_000,
});

try {
  const capabilities = await client.getCapabilities();
  const { users } = await client.invoke(
    "users.search",
    { query: "john@example.com" },
    { signal: AbortSignal.timeout(5_000) },
  );
  console.log(capabilities.product.name, users.length);
} catch (error) {
  if (!(error instanceof ControlClientError)) throw error;
  console.error(error.code, error.requestId);
  process.exitCode = 1;
}
```

<!-- /quickstart-client -->

`invoke` validates input and returns the operation's `data`: for example, `{ users }`, `{ subscription }`, or `null` for a mutation. Call an action with `client.invoke("actions.invoke", { actionId: "count-matches", input: { query: "john" } })`. Custom action results have the shared `JsonValue` type; validate product-specific result shapes in your application.

The client defaults to protocol v1 for existing integrations. To create a user, construct it with `protocolVersion: "2"`, confirm that discovery advertises `users.create`, then call `client.invoke("users.create", { email, name })`. The result is `{ user }`. Protocol v1 discovery never advertises creation, even if the handler registers it.

Each call uses a fresh request ID and signature. The client validates response envelopes, request IDs, operation results, and HTTP statuses. It rejects redirects and does not retry. Endpoints require HTTPS, with HTTP allowed only for loopback development addresses. The default response limit is 1 MiB. Optional call options accept `actor` for audit attribution and `signal` for cancellation. Errors have stable codes and sanitized messages; client cancellation is `REQUEST_ABORTED`, the configured deadline is `REQUEST_TIMEOUT`, and malformed responses are `INVALID_RESPONSE`. See the [client contract](./docs/PROTOCOL.md#client-configuration-and-execution) for options and limits.

## Security model

Every connected product must use separate credentials. Requests are protected using HMAC-SHA256 signatures that cover the key ID, method, path, timestamp, request ID, protocol version, and exact body hash.

The server also enforces:

- Bounded request timestamps
- Unique request IDs
- Replay rejection
- Runtime input validation
- Explicit capability registration
- Request body limits
- Sanitized error responses
- Constant-time signature comparison

The endpoint must be treated as publicly discoverable. Security must never depend on hiding its URL.

## Technology

- TypeScript in strict mode
- Node.js 22+
- ESM only
- npm
- Zod
- Vitest
- tsup
- Node/Web Crypto
- GitHub Actions
- npm Trusted Publishing

## Development

Implementation is divided into five phases in [`PLAN.md`](./PLAN.md). AI coding agents should read [`AGENTS.md`](./AGENTS.md) before changing the repository.

Use an up-to-date Node.js 22+ release (at least 22.13 on the Node 22 line for the development tools) and npm. The package runtime requirement is Node.js 22+.

Stop the example development server before running type checking or building; the [example guide](./examples/nextjs/README.md#configuration-and-development) explains the Next.js generated-type compatibility handling.

```bash
npm install
npm run example:setup
npm run typecheck
npm test
npm run test:package
npm run lint
npm run build
npm audit
npm pack --dry-run
```

`npm run typecheck` and `npm run build` include the SDK and the Next.js example. `npm test` runs deterministic unit, security, client/handler integration, compile-time API, packaging, and Next.js end-to-end tests. `npm run test:package` runs the packaging tests separately: they install a real tarball into a temporary project, type-check the README examples, and execute a signed HTTP round trip. After dependency installation, tests need no external services or running development server. `npm run lint` includes type-aware ESLint and Prettier checks. Use `npm run format` to format the repository. Generated builds, local credentials, dependency installations, and tarballs are ignored.

After building, this local example uses the real root entry point:

```bash
node --input-type=module <<'JS'
import { controlRequestSchema } from '@yanvah/control';

const request = controlRequestSchema.parse({
  operation: 'users.search',
  input: { query: 'john@example.com', limit: 20 },
});
console.log(JSON.stringify(request));
JS
```

No request is sent by this schema example. Integration tests connect the real client and handler; security tests also use independent Node cryptography. The local Next.js example and smoke script exercise the built public package exports. A dependency lockfile is included; Zod is the SDK's only runtime dependency. Next.js and its React peers belong to the private example workspace.

CI checks Node.js 22 and 24. Publishing is a separate manual workflow; see [release instructions](https://github.com/yanvah/control-sdk/blob/main/docs/RELEASING.md). Running builds, tests, or `npm pack` never publishes a package.

## Project goals

The integration requires:

1. Installing `@yanvah/control`
2. Registering supported administrative functions
3. Exposing one protected HTTP endpoint
4. Adding the SaaS URL and credentials to Yanvah Control

A new SaaS should be connectable without modifying Yanvah Control or the SDK internals.

## Contributing

See [CONTRIBUTING.md](https://github.com/yanvah/control-sdk/blob/main/CONTRIBUTING.md) for setup and checks, and the [Code of Conduct](https://github.com/yanvah/control-sdk/blob/main/CODE_OF_CONDUCT.md) for community expectations. Report suspected vulnerabilities privately using [SECURITY.md](./SECURITY.md), rather than public issues. Changes prepared for the first release are listed in [CHANGELOG.md](./CHANGELOG.md).

## License

Licensed under the [Apache License 2.0](./LICENSE).

Copyright 2026 Yanvah LLC.
