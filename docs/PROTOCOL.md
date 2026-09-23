# Yanvah Control protocols v1 and v2

The SDK implements the signed Control client, request authentication, replay
protection, and the SaaS-side handler for every operation below. Parsing a schema
alone never authenticates a request.

## Versioning and encoding

`PROTOCOL_VERSION` remains `"1"` for existing callers. The SDK supports versions
`"1"` and `"2"`, carried in `X-Yanvah-Version` and in capability data. The
version is independent of the npm package version. A client defaults to v1 and
must explicitly set `protocolVersion: "2"` to invoke creation. The SDK does not
negotiate or retry a request under a different version. Unknown versions are rejected.

Version 1 retains its closed object shapes, operation names, and enum values. Changes to
those shapes or meanings, including new fields, operations, or enum members that
existing validators would reject, require a new protocol version. Version 2 adds
`users.create` and `USER_ALREADY_EXISTS`; other v1 operations retain their shapes.
SDK fixes that
preserve this contract do not change the protocol version. An unsupported but
known operation is different from an unsupported protocol version.

Requests and responses use UTF-8 JSON and `Content-Type: application/json`. Object
key order and insignificant whitespace are unrestricted. Fixed objects reject
unknown keys instead of silently stripping them. Schemas do not coerce values,
trim strings, or insert defaults. Optional fields may be omitted; `null` is accepted
only where explicitly documented. Empty strings are not substitutes for missing
values. Wire payloads are JSON trees, not JavaScript class instances.

`JsonValue` / `jsonValueSchema` accepts null, booleans, finite numbers, strings,
arrays, and objects recursively. It rejects undefined, functions, symbols,
bigints, non-finite numbers, class instances (including dates), sparse arrays,
cycles, accessor properties, and properties that would be lost in serialization.
JSON-valued fields permit at most 64 nested container levels, counting their root
object or array as level 1. Keys `__proto__`, `constructor`, and `prototype` are
reserved and rejected at every level. This also applies to custom action payloads
and success data. TypeScript cannot encode every runtime constraint; validate
untrusted values even when they have a declared type.

## Endpoint and authentication headers

Every operation uses one configured endpoint, normally:

```text
POST https://example.com/api/yanvah-control
```

The endpoint must use HTTPS in production. Its URL has no query string or fragment.
Credentials never appear in the URL or JSON body. Endpoint secrecy and private
networking do not replace authentication, including during local development.
The handler permits an HTTP `Request` for local use and trusted TLS-terminating
proxies; the deployment must enforce HTTPS on the external connection.

`CONTROL_HEADERS` maps the logical fields below to HTTP header names. HTTP header
names are case-insensitive. `requestHeadersSchema` validates a plain object with
the five logical keys; it does not extract headers from a `Request`, check key
registration, verify a signature, validate freshness, or consume a replay ID.

| Logical field | HTTP header           | Value                                                                                                                                     |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `version`     | `X-Yanvah-Version`    | Exactly `1` or `2`                                                                                                                        |
| `keyId`       | `X-Yanvah-Key-Id`     | 1–128 ASCII letters, digits, `_`, or `-`; case-sensitive                                                                                  |
| `timestamp`   | `X-Yanvah-Timestamp`  | Unix epoch milliseconds as a nonnegative decimal string; no leading zero except `0`; at most `Number.MAX_SAFE_INTEGER` (9007199254740991) |
| `requestId`   | `X-Yanvah-Request-Id` | UUIDv4; generated independently for each request, including retries                                                                       |
| `signature`   | `X-Yanvah-Signature`  | Exactly 64 lowercase hexadecimal characters; no prefix                                                                                    |

All five headers are mandatory and single-valued. Values must not contain
whitespace or line breaks. The handler validates the values exposed by Web
`Headers` without further trimming or normalization; comma-combined duplicates
fail validation. Web `Headers` and upstream servers may already trim whitespace
or discard duplicate fields, so the handler cannot inspect the original HTTP
header lines. Reject ambiguous duplicate headers at the ingress as well. UUID
letter case is accepted and preserved in the canonical string; clients should
generate standard lowercase UUIDs.

## Signature contract

Each product connection has its own key ID and secret. Treat the configured secret
as literal UTF-8 text, not an implicitly decoded base64 or hexadecimal value. Use a
cryptographically generated secret with at least 256 bits of entropy. Handler
configuration requires 32–1024 UTF-8 bytes of nonblank secret text; this length
check cannot establish entropy. The client applies the same credential rules.
The secret is never transmitted in a request.

Hash the **exact outgoing/received body bytes** with SHA-256. Encode that hash as
64 lowercase hexadecimal characters. Do not parse and reserialize JSON first.

Construct the following seven lines in order, separated by a single LF (`\n`),
without a trailing newline:

```text
<version>
<keyId>
<timestamp>
<requestId>
<method>
<pathname>
<bodySha256Hex>
```

`pathname` is `new URL(request.url).pathname`, including the leading slash and any
percent encoding as returned by the URL API; it excludes the origin, query, and
fragment. Do not decode it or remove a trailing slash. Client and server must agree
on the path visible to the handler, including any reverse-proxy rewrite.
`method` is `request.method`, normally `POST`. Sign the exact values exposed by
the standard `Request` and URL APIs.

The signature is lowercase hex of HMAC-SHA256 over the UTF-8 canonical string,
using the secret's UTF-8 bytes. Verification must use established platform crypto
and compare equal-length decoded signature bytes in constant time. Changed method,
path, signed headers, or body bytes must fail verification. Unsupported methods
are rejected; operation names are never inferred from paths or function names.

The handler verifies the signature before checking timestamp freshness and
consuming the replay ID. A timestamp is accepted when
`Math.abs(Date.now() - timestamp) <= timestampToleranceMs`. Both boundaries are
inclusive. The replay record expires at `timestamp + timestampToleranceMs + 1`
milliseconds, retaining it through the last accepted millisecond even for a
future-dated request. UUIDs are lowercased only for replay storage, so changing
UUID letter case and signing again cannot reuse an ID. Responses preserve its
received case. Freshness is checked again after replay storage completes.

An authenticated, fresh request consumes its ID before JSON and operation input
validation; a failed operation does not release that ID. Invalid signatures and
stale timestamps do not consume IDs. A retry needs a new UUIDv4, and mutations
require application-level handling of uncertain outcomes. The client serializes
the body once, then signs and sends the same bytes. It never retries automatically.

## Handler configuration and execution

`createControlHandler` from `@yanvah/control/server` accepts `product`,
`auth: { keyId, secret }`, and a `replayStore`. All are required and validated when
the factory is called. Invalid configuration throws a sanitized `TypeError`.
The optional `users` object registers individual callbacks: `create` (v2), `search`, `get`,
`ban`, `unban`, and `revokeSessions`. `subscriptions` registers `get` and
`changePlan`. `actions` maps explicit action IDs to registrations described below.
An omitted callback is unavailable. Configuration and registration objects must
be plain objects or have a null prototype; inherited registrations are rejected.
A replay store may be a class instance, and its `consume` method retains its
receiver.

| Optional setting       | Default            | Allowed integer range |
| ---------------------- | ------------------ | --------------------- |
| `timestampToleranceMs` | 300000 (5 minutes) | 0–300000              |
| `maxBodyBytes`         | 65536 (64 KiB)     | 1–1048576             |
| `requestTimeoutMs`     | 10000 (10 seconds) | 1–60000               |

The returned function accepts a standard `Request` and returns
`Promise<Response>`. It reads actual stream bytes up to `maxBodyBytes` before
decoding or parsing JSON; `Content-Length` is not trusted as the size boundary.
When present, `Content-Length` must be a canonical nonnegative decimal integer,
fit within the limit, and match the received byte count.
Use `Content-Type: application/json`, optionally with `charset=utf-8`.
Other media types, non-UTF-8 JSON, compressed request bodies, and URL queries or
fragments produce `INVALID_INPUT`. `Content-Encoding` may be absent or `identity`.
Unsigned discovery is rejected like any other unsigned operation. An unsupported
method with a valid signature produces `OPERATION_UNSUPPORTED`; tampering with a
signed method produces `AUTHENTICATION_FAILED`.

Each callback receives validated input followed by
`{ requestId, actor, signal }`. `actor` is undefined when omitted from the request.
`users.search` receives an effective integer `limit` and returns `User[]`;
`users.get` returns `User | null`. `subscriptions.get` returns
`Subscription | null`. `users.create` returns the created `User`. The ban, unban,
session-revocation, and plan-change callbacks return `void` or `Promise<void>`; any runtime
return value from those callbacks is ignored and success uses `null`. Callbacks may be synchronous or
asynchronous. Search/get results are validated before serialization; malformed
results and search results exceeding the effective limit produce `INTERNAL_ERROR`.
A non-null user lookup result must have the requested `userId` as its `id`; a
subscription lookup result must have that `userId` as its `userId`.

The timeout covers body reading, replay storage, and callback execution. Request
cancellation or a deadline produces `REQUEST_TIMEOUT` and aborts the callback's
signal. Pass that signal to cancellable downstream work. A timeout cannot undo a
committed mutation, forcibly stop a callback that ignores cancellation, or preempt
synchronous JavaScript. Do not automatically retry mutations after a timeout.

## Client configuration and execution

`createControlClient` from `@yanvah/control/client` requires `endpoint`, `keyId`,
and `secret`. It validates configuration once and throws a sanitized `TypeError`
for invalid options. The endpoint is a URL string without user information, a
query, or a fragment. HTTPS is required except that HTTP is accepted for
`localhost`, `127.0.0.1`, and `[::1]` development endpoints. Requests to those
addresses are still signed. Configure endpoints only from trusted connection
settings, not arbitrary request input.

| Optional setting   | Default            | Allowed value                                |
| ------------------ | ------------------ | -------------------------------------------- |
| `timeoutMs`        | 10000 (10 seconds) | Integer, 1–60000                             |
| `maxResponseBytes` | 1048576 (1 MiB)    | Integer, 1–10485760                          |
| `protocolVersion`  | `"1"`              | `"1"` or `"2"`; creation requires v2         |
| `fetch`            | Platform `fetch`   | A trusted function with the `fetch` contract |

`client.invoke(operationName, input, options?)` returns a
`Promise<OperationResult<typeof operationName>>`. Input is required, including
`{}` for `system.capabilities`. `client.getCapabilities(options?)` is a convenience
for that operation. Call options are `{ actor?, signal? }`; `actor` follows the
wire attribution model and `signal` must be an `AbortSignal`. Operation names,
input, and options are validated before a request is sent. Unknown operation names
produce `OPERATION_UNSUPPORTED`; invalid input/options produce `INVALID_INPUT`.

Each call generates a fresh UUIDv4 and epoch-millisecond timestamp, serializes
the validated request once, and signs its exact bytes. It sends one `POST` request
with redirects disabled. There are no retries or capability cache. A custom
`fetch` is trusted transport code and must honor the request's redirect and signal
settings.

The deadline covers the outgoing request and response body. Caller cancellation
produces `REQUEST_ABORTED`; the configured deadline produces `REQUEST_TIMEOUT`.
Both abort the transport signal. An unreachable product or failed transport
produces `PRODUCT_UNAVAILABLE`. Cancellation and timeouts cannot establish whether
the SaaS already applied a mutation.

The client limits bytes exposed by `fetch` before decoding UTF-8 JSON, including
decompressed response bytes. For an unencoded response, `Content-Length`, when
present, must be canonical and match the received size. Compressed length is not
compared with the decoded body. The client requires the JSON media type, a valid
envelope, the exact outstanding request ID,
and the documented HTTP status for success or the returned error code. Success
data must match the operation's result schema and request-dependent constraints:
protocol version on discovery, search limit, user lookup ID, and subscription lookup user ID. Malformed,
oversized, mismatched, or unexpected responses produce `INVALID_RESPONSE`.

Failures are `ControlClientError` instances with a stable `code` and the local
`requestId`. Messages are fixed; raw transport exceptions and remote error messages
are not exposed. A valid server error retains its wire code. `INVALID_RESPONSE`
and `REQUEST_ABORTED` are client-only codes, not additions to the v1 wire enum.

## Replay store contract

```ts
interface ReplayStore {
  consume(requestId: string, expiresAt: Date): Promise<boolean>;
}
```

`consume` must atomically return `true` and retain a previously unused ID until
`expiresAt`, or return `false` when it is already retained. Concurrent requests
with the same ID must produce at most one `true`. Never evict an unexpired ID to
make room. Namespace records per product connection, and share the same namespace
across every instance serving that connection. Storage errors must throw;
the handler returns `PRODUCT_UNAVAILABLE` if storage throws or returns a
non-boolean value. A duplicate returns `REQUEST_REPLAYED`.

`createMemoryReplayStore({ maxEntries: 10000 })` is provided for local development
and a single process. `maxEntries` is optional and permits 1–1000000 entries.
Expired entries are removed during consumption; filling the store fails closed
instead of evicting live entries. Create it once, outside the request handler.
Its state is lost on restart. Distributed or serverless deployments require a
shared atomic implementation using a database, Redis, or equivalent storage;
use durable storage when replay protection must survive restarts. The SDK does
not provide a database dependency or store adapter.

## Request envelope

`ControlRequest` / `controlRequestSchema` is a discriminated union keyed by
`operation`. `input` is required even for an operation with no parameters.

```json
{
  "operation": "users.ban",
  "actor": { "id": "control-admin", "email": "admin@example.com" },
  "input": { "userId": "user_123", "reason": "Chargeback abuse" }
}
```

`actor` is optional for every operation. When present, its `id` is required and
`email` is optional. It represents a caller-supplied audit attribution, covered by
the body signature; it is not independent proof of user identity or authorization.
Product credentials authenticate the connection. The SaaS owns business rules and
authorization for the registered operation.

## Shared models

IDs in product, actor, user, subscription, and operation payload fields are opaque,
nonblank strings of 1–256 characters. They need not be UUIDs. An action ID is 1–64
ASCII characters matching `[a-z][a-z0-9-]*`. A request ID uses the UUIDv4 rule above.
Email fields are valid email strings of at most 254 characters. Date/time fields
are strings in UTC with exactly millisecond precision, for example
`2026-09-19T12:00:00.000Z`; offsets, date-only strings, and `Date` objects are rejected.
String limits are measured in Unicode code points.

| Type / schema                                 | Required fields                                                                                 | Optional fields                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Actor` / `actorSchema`                       | `id`                                                                                            | `email` (not null)                                                                                             |
| `Product` / `productSchema`                   | `id`, `name` (nonblank, 1–200 characters)                                                       | None                                                                                                           |
| `User` / `userSchema`                         | `id`                                                                                            | `email` (nullable), `name` (nullable, otherwise 1–200 characters), `banned` (boolean), `createdAt` (date/time) |
| `Subscription` / `subscriptionSchema`         | `id`, `userId`, `planId`, `status`                                                              | `currentPeriodEnd` (nullable date/time)                                                                        |
| `ActionCapability` / `actionCapabilitySchema` | `id`, `label` (nonblank, 1–200 characters), `description` (nonblank, 1–2000 characters), `risk` | None                                                                                                           |

An omitted user field means the SaaS did not provide it; `email: null` or
`name: null` explicitly indicates no value. An omitted `banned` field does not mean
the user is unbanned. A null subscription period end indicates no scheduled end;
omission means the SaaS did not provide it. No arbitrary database records or
metadata bags are included in these models.

`SubscriptionStatus` / `subscriptionStatusSchema` has five normalized values:
`trialing`, `active`, `past_due`, `paused`, and `canceled`. The SaaS maps its billing
state into these values; this package does not integrate with a billing vendor.

`ActionRisk` / `actionRiskSchema` is `safe`, `caution`, or `dangerous`. Risk must be
declared explicitly. It is descriptive metadata, not permission to execute an
action. Dangerous actions remain explicitly registered and opt-in.

## Operations and payloads

`OPERATION_NAMES` and `OperationName` define this closed set.
`operationInputSchemas[name]` and `operationResultSchemas[name]` validate each
operation's payload. `OperationInput<Name>` and `OperationResult<Name>` provide the
corresponding TypeScript types. Defining a schema does not register or implement
the operation.

| Operation                  | Input                            | Success `data`                           |
| -------------------------- | -------------------------------- | ---------------------------------------- |
| `system.capabilities`      | `{}`                             | `Capabilities` (below)                   |
| `users.create` (v2)        | `{ email, name? }`               | `{ user: User }`                         |
| `users.search`             | `{ query, limit? }`              | `{ users: User[] }`, at most 100 users   |
| `users.get`                | `{ userId }`                     | `{ user: User \| null }`                 |
| `users.ban`                | `{ userId, reason? }`            | `null`                                   |
| `users.unban`              | `{ userId }`                     | `null`                                   |
| `users.revokeSessions`     | `{ userId }`                     | `null`                                   |
| `subscriptions.get`        | `{ userId }`                     | `{ subscription: Subscription \| null }` |
| `subscriptions.changePlan` | `{ userId, planId }`             | `null`                                   |
| `actions.invoke`           | `{ actionId, input: JsonValue }` | `JsonValue`                              |

Search `query` is a nonblank string of 1–256 characters. `limit`, if provided, is
an integer from 1 to 100. An omitted limit means 20 at execution time; the wire
schema preserves omission. The SaaS chooses matching and ordering and must return
no more than the requested/default limit. There is no pagination or total count
in v1. Result schemas enforce the absolute 100-user bound; the handler and client
also enforce the requested limit using the request context.

Ban `reason`, if present, is nonblank and 1–2000 characters. Ban, unban, session-revocation,
and plan-change success uses
`null` so business functions need not return an updated record; the handler
normalizes a completed void-returning function to this wire value. Lookup
absence is represented by `{ "user": null }` or `{ "subscription": null }`, not
an error or a missing `data` field. Subscription lookup represents the SaaS's
selected administrative subscription for that user.

Creation requires a valid email of at most 254 characters. Optional `name` is
nonblank and at most 200 characters. The handler returns the created `User` in
`{ user }`; the SaaS owns invitation delivery and account defaults. A v1 client
cannot invoke creation, and a v1 capability response never lists it. A SaaS may
throw `ControlHandlerError("USER_ALREADY_EXISTS")` only when it can confirm no
account was created. Other callback failures remain sanitized as `INTERNAL_ERROR`.

Custom actions always use the fixed `actions.invoke` operation, with the explicit
registered ID inside its input. The nested `input` key is mandatory; use `null` for
no parameters. The wire schema validates JSON compatibility. Register each action
under `actions[actionId]` with `label`, `description`, `risk`, a `run` callback, and
an optional Zod `input` schema. The schema validates business input before `run`
and supplies its inferred output type to the callback, including transformations.
Async schemas are supported; validation is included in the handler deadline.
Without a schema, `run` receives `JsonValue`. The callback also receives the usual
handler context and must return a JSON-compatible result, synchronously or
asynchronously.

Inline registrations infer the schema output automatically. For a separately
declared, explicitly typed action, use `ActionDefinition<typeof inputSchema>`;
the default `ActionDefinition` type describes an action without a schema.

Unknown or unregistered action IDs return `OPERATION_UNSUPPORTED`. Business input
that fails the registered schema returns `INVALID_INPUT` without running the
action. Invalid action results, thrown schema exceptions, or thrown callbacks
return sanitized `INTERNAL_ERROR`. Action schemas and callbacks are trusted SaaS
code; the SDK does not infer permissions from the risk label.

## Capability discovery

`Capabilities` / `capabilitiesSchema` describes exactly the registered handlers.
The handler generates this response from its configuration; discovery itself is
always present. For example, registering only `users.search` produces:

```json
{
  "product": { "id": "example-saas", "name": "Example SaaS" },
  "sdkVersion": "0.2.0",
  "protocolVersion": "1",
  "operations": ["system.capabilities", "users.search"],
  "actions": []
}
```

All five top-level keys are required. `sdkVersion` is the producing SDK's npm
version, represented by a nonblank string of 1–64 characters. `operations` contains
unique known operation names and always includes `system.capabilities`. `actions`
contains unique action IDs. `actions.invoke` is present if and only if at least one
action is listed. A product with only discovery uses
`operations: ["system.capabilities"]` and `actions: []`. List order has no meaning.
`sdkVersion` comes from the package version at build time.
Discovery is version-specific: the same handler may advertise `users.create`
for a v2 request and omit it for a v1 request.

Action metadata is limited to ID, label, description, and risk. Raw Zod objects,
executable schemas, functions, and JSON Schema serialization are not part of v1.
An input-editor/schema-discovery API is deferred. Never advertise capabilities
from arbitrary URLs, function names, or
unregistered functions.

## Response envelope and validation

`ControlResponse` / `controlResponseSchema` discriminates on the boolean `ok`.
Both success and error responses require a UUIDv4 `requestId`. Echo a valid
incoming ID exactly. If the incoming ID is absent or malformed, the handler
generates a fresh UUIDv4 rather than reflecting an untrusted invalid value.
Every response has JSON content type and `Cache-Control: no-store`.

```json
{
  "ok": true,
  "requestId": "7a1aaed4-b884-4d9c-8148-c5c79be928c6",
  "data": { "users": [{ "id": "user_123", "email": "john@example.com" }] }
}
```

```json
{
  "ok": false,
  "requestId": "7a1aaed4-b884-4d9c-8148-c5c79be928c6",
  "error": {
    "code": "OPERATION_UNSUPPORTED",
    "message": "This product does not support the requested operation."
  }
}
```

`ControlSuccessResponse` / `controlSuccessResponseSchema` requires JSON-compatible
`data` and rejects an `error` key. `ControlErrorResponse` /
`controlErrorResponseSchema` requires `error: { code, message }` and rejects `data`.
Messages are nonblank strings of 1–512 characters. There is no stack, cause,
details, or raw provider error field.

The response envelope does not repeat the operation, so it cannot alone prove
that success data matches the request. A client must validate the envelope,
compare its request ID with the outstanding request, and then validate `data`
against that operation's result schema. It must also enforce request-dependent
constraints such as the search limit. `createControlClient` performs these checks.

This runnable example exercises the protocol schemas after `npm run build`:

```bash
node --input-type=module <<'JS'
import {
  controlRequestSchema,
  controlResponseSchema,
  operationResultSchemas,
} from '@yanvah/control';

const request = controlRequestSchema.parse({
  operation: 'users.search',
  input: { query: 'john@example.com' },
});
const expectedId = '7a1aaed4-b884-4d9c-8148-c5c79be928c6';
const response = controlResponseSchema.parse(JSON.parse(JSON.stringify({
  ok: true,
  requestId: expectedId,
  data: { users: [{ id: 'user_123', email: 'john@example.com' }] },
})));
if (response.requestId !== expectedId) throw new Error('Mismatched request ID');
if (response.ok) {
  console.log(operationResultSchemas[request.operation].parse(response.data));
} else {
  console.log(response.error.code);
}
JS
```

## Normalized errors

`ERROR_CODES`, `ErrorCode`, and `errorCodeSchema` define these stable codes. The
status column specifies the HTTP handler contract; a transport-side client
failure may have no HTTP response. Success uses HTTP 200.

| Code                    | HTTP status | Meaning                                                                                                                 |
| ----------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `AUTHENTICATION_FAILED` | 401         | Missing/malformed auth headers, unknown key or protocol version, or invalid signature; do not reveal which check failed |
| `REQUEST_EXPIRED`       | 401         | Authenticated timestamp outside the configured past/future window                                                       |
| `REQUEST_REPLAYED`      | 409         | Authenticated request ID was already consumed                                                                           |
| `INVALID_INPUT`         | 400         | Malformed JSON, oversized body, unsupported body encoding, invalid URL shape, or invalid operation input                |
| `OPERATION_UNSUPPORTED` | 400         | Unknown/unregistered operation or action, or unsupported HTTP method                                                    |
| `USER_ALREADY_EXISTS`   | 409         | Definite v2 creation conflict reported by the SaaS when no account was created                                          |
| `PRODUCT_UNAVAILABLE`   | 503         | Replay store unavailable or full; also usable for client connection failures                                            |
| `REQUEST_TIMEOUT`       | 504         | Request timed out or was canceled; also usable for a client timeout                                                     |
| `INTERNAL_ERROR`        | 500         | Unexpected SDK or developer-handler failure, or invalid handler result                                                  |

Unknown operations fail `controlRequestSchema`; the handler distinguishes an
unknown operation from a known operation with invalid input before execution.
Schemas validate the response's structure, not the safety of arbitrary message
text. The handler uses fixed messages and never returns Zod issues, exception
messages, stack traces, or provider errors. It does not log requests or errors.
The client replaces remote error text with fixed messages and adds local
`INVALID_RESPONSE` and `REQUEST_ABORTED` codes through `ControlClientErrorCode`.
HTTPS protects responses; neither protocol version defines a response signature.

## Package surface

The root entry point exports the types, schemas, and constants named in this
document. `ProtocolVersion` / `protocolVersionSchema`, `OperationName` /
`operationNameSchema`, and `RequestHeaders` / `requestHeadersSchema` cover the
version, operation names, and header fields. Types are derived from the runtime
schemas to keep them aligned. Internal identifier, date, and JSON guard helpers
are not public exports.

`@yanvah/control/server` exports `createControlHandler`, `ControlHandlerError`,
`createMemoryReplayStore`, and the types `ControlHandler`, `ControlHandlerOptions`,
`ControlHandlerContext`, `UsersHandlers`, `SubscriptionsHandlers`,
`ActionDefinition`, `ReplayStore`, and `MemoryReplayStoreOptions`.
`@yanvah/control/client` exports `createControlClient`, `ControlClientError`, and
the types `ControlClient`, `ControlClientOptions`, `ControlInvokeOptions`, and
`ControlClientErrorCode`. Cryptographic helpers remain internal. No deep imports
or CommonJS entry point are provided. See
[THREAT_MODEL.md](./THREAT_MODEL.md) for
the deployment assumptions and limits of these controls.
