# Threat model

This document covers the signed Control client and the SaaS-side handler,
including user operations, subscriptions, and custom actions. The complete wire
contract is in [PROTOCOL.md](./PROTOCOL.md).

## Trust boundary

An unauthenticated remote caller can reach the endpoint and control its method,
URL, headers, body, timing, and concurrent requests. Captured requests may be
replayed. The SDK must prevent those requests from invoking registered business
functions without a valid signature, fresh timestamp, unused request ID, and
valid operation input.

The product connection secret, SaaS process, registered callbacks, runtime,
dependencies, and replay-store implementation are trusted. A compromised secret
allows the holder to invoke every registered operation for that connection.
The optional signed `actor` is caller-supplied audit attribution, not independent
proof of identity or authorization. Control owns administrator authentication;
the SaaS owns business authorization and database effects.

The Control process, configured endpoint, and optional custom `fetch` are trusted.
Product responses are untrusted: the client validates their bounded JSON bodies,
envelopes, request IDs, statuses, and operation results before returning data.
Control must authorize who can configure product endpoints and invoke operations.

## Controls and limits

| Threat                                 | SDK control                                                                                                                                                                               | Remaining responsibility                                                                                     |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Forged or modified requests            | HMAC-SHA256 covers protocol version, key ID, timestamp, request ID, method, pathname, and SHA-256 of the exact received bytes. Equal-length signature bytes use constant-time comparison. | Generate and protect a separate random secret per connection; never log secrets or signatures.               |
| Captured request replay                | Bounded past/future timestamps and atomic request ID consumption before execution. UUID case aliases share one replay record.                                                             | Keep clocks synchronized and use shared durable replay storage when the deployment requires it.              |
| Invalid or unintended operations       | Strict Zod input validation and an explicit registration list; discovery advertises only registered callbacks.                                                                            | Register only intended operations and enforce product-specific permission and business rules.                |
| Large or stalled requests              | A streaming byte limit before JSON parsing, bounded configuration, and a deadline covering body reading, replay storage, and callbacks.                                                   | Set ingress rate, connection, header, and body limits; application code must bound its own work and results. |
| Large, stalled, or malformed responses | A client response byte limit, deadline, strict envelope/result validation, and exact request ID matching.                                                                                 | Apply network policy to product endpoints; transport cancellation cannot undo remote effects.                |
| Sensitive data disclosure              | Fixed error messages, validated success models, no SDK logging or telemetry, and `Cache-Control: no-store`.                                                                               | Expose only intended user fields and protect application/proxy logs and responses.                           |
| Redirected signed requests             | The client disables redirects and does not automatically retry.                                                                                                                           | Custom transports must honor redirect restrictions; configure the final trusted endpoint directly.           |
| Concurrent duplicate mutations         | A replay store admits at most one request with a given ID while retained.                                                                                                                 | Replay protection does not make business operations idempotent across different IDs.                         |

Signature comparison does not make the whole endpoint constant-time: malformed
headers and unknown keys may be rejected earlier. Authentication errors use the
same response code and message. Body-size and transport-format failures may be
rejected before signature verification without invoking a callback.

All operations, including capability discovery, require signatures on localhost
as well as in production. There is no authentication bypass. The endpoint is
assumed discoverable; a private network can add protection but cannot replace
request authentication.

## Transport and proxies

Use HTTPS externally. HMAC authenticates requests; it does not encrypt request
bodies or authenticate response bodies. Responses rely on TLS. The handler accepts
an HTTP `Request` to support local development and trusted TLS-terminating proxies;
it cannot prove that the original caller used HTTPS.

The client requires HTTPS except for HTTP development endpoints on `localhost`,
`127.0.0.1`, or `[::1]`. It rejects URL user information, queries, and fragments,
and never follows redirects. Local HTTP provides no transport confidentiality or
response authentication. This exception is for trusted local development only.
The client is not an SSRF firewall: HTTPS endpoints can resolve to private
addresses, and DNS resolution follows the platform transport. Control must treat
endpoint registration as privileged configuration and apply its network policy.

The reverse proxy must preserve the body bytes and the signed path as seen by the
handler. It must not decompress or reserialize a request after signing. Request
queries and fragments are rejected because they are not signed. The origin is not
part of the signature; unique secrets and separate replay namespaces bind each
product connection. Do not expose multiple independent handlers with the same
credentials and separate replay stores.

Web `Headers` can trim whitespace and combine duplicate fields before the SDK
sees them. The SDK rejects malformed and comma-combined authentication values;
the ingress must reject ambiguous raw duplicate headers that would otherwise be
discarded. Logs at every layer should exclude authentication headers and
sensitive request bodies.

## Replay storage

`consume(requestId, expiresAt)` must atomically test and reserve an ID until the
given expiry. The handler retains IDs through
`timestamp + timestampToleranceMs + 1` milliseconds, including the future-skew
allowance and inclusive timestamp boundary. Storing only for one tolerance period
from receipt could permit future-dated requests to replay. The handler checks
freshness again after waiting for the store.

Authenticated requests consume their IDs even if later input validation or
execution fails. Store errors and invalid store results fail closed with
`PRODUCT_UNAVAILABLE`; no registered callback executes. The in-memory store bounds
its entries and fails closed when full, keeping every unexpired record.

Create one store outside the request function for each product connection.
In-memory storage protects one running process only: independent workers do not
share records, and restarts erase them. Distributed and serverless deployments
need shared atomic storage. Durable storage is required to retain protection
across restarts; its TTL must not expire records before the supplied deadline.
Keep server and storage clocks synchronized. A severely incorrect or rolled-back
clock can undermine timestamp and expiry assumptions.

## Timeouts and mutation outcomes

The handler aborts its callback signal when the incoming request is canceled or
the configured timeout expires and returns `REQUEST_TIMEOUT`. It does not forward
the caller's arbitrary abort reason into the callback context. Callbacks should
pass the signal to downstream APIs that support cancellation.

The client has its own deadline covering transport and response reading. It
returns `REQUEST_TIMEOUT` when that deadline expires and `REQUEST_ABORTED` for a
caller's `AbortSignal`. Transport exceptions, remote error messages, and arbitrary
abort reasons are replaced with fixed errors. The client does not retry either
reads or mutations automatically.

Cancellation cannot undo committed effects, stop a callback that ignores its
signal, or preempt synchronous JavaScript. A callback may finish a mutation after
the caller receives a timeout. A request whose replay-store call outlives the
deadline may consume an ID without executing an operation. Neither outcome makes
retrying a mutation with a new ID safe. The SaaS must provide business-level
idempotency or reconciliation where required.

## Custom actions

Only explicitly registered IDs can execute. Each action declares its risk level;
the label is discovery metadata, not an authorization check or an SDK confirmation
flow. Control and the SaaS must enforce their own permission and confirmation
policies before invoking dangerous operations.

All action payloads pass the JSON safety rules, including reserved-key and nesting
limits. An optional registered Zod schema then validates business input before
execution. Async schemas and transformations are trusted developer code; they
must bound their own work and avoid side effects during validation. Without a
schema, the action accepts any valid `JsonValue`, so register a schema when the
action expects a particular structure. Results must also be safe JSON; capability
discovery exposes metadata only, never executable schemas.

## Secrets and exposure

Use a cryptographically random secret with at least 256 bits of entropy. The
configured secret is literal UTF-8 text, not implicitly decoded hex or base64.
The SDK enforces a length of 32–1024 UTF-8 bytes and rejects blank values; it cannot
measure randomness. Store secrets outside source control and use different
credentials for each product connection and environment.

The handler accepts one key ID and secret. Rotation requires coordinated
configuration changes; simultaneous old/new keys are not an implemented API.
Do not expose arbitrary SQL, shell commands, JavaScript execution, unrestricted
HTTP requests, or database credentials through registered callbacks. Sanitized
SDK errors cannot prevent a trusted callback from deliberately returning or
logging confidential data.

Tests cover signing vectors, tampering, timestamp boundaries, concurrent replay,
limits, routing, action validation, exception sanitization, client/handler round
trips, malformed responses, and cancellation without external services. They
verify these controls, not the security of a deployment's proxy, durable store,
credentials, transport replacement, or business callbacks.
