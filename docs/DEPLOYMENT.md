# Deploying a Control connection

The [README integration](../README.md#five-minute-nextjs-integration) uses local fixtures. A production SaaS must own the following configuration and business rules. The [threat model](./THREAT_MODEL.md) explains the boundaries in detail.

## Secrets and registration

Generate at least 32 random bytes per connection and environment, then encode them as hex or base64 text for storage. The SDK signs with the literal UTF-8 value; both sides must use exactly the same text. Store it in a secret manager or server-only environment variable, never a `NEXT_PUBLIC_` variable, URL, request body, repository file, or log. Redact authentication headers and sensitive bodies in application, proxy, and observability tooling.

Register only operations that should be callable by the holder of that connection's secret. The SaaS remains responsible for permissions, business invariants, and audit persistence. Signed `actor` data is attribution from Control, not proof of a person's identity. Action risk labels do not enforce approvals.

## HTTPS and reverse proxies

Use the final HTTPS endpoint directly; the client rejects redirects. Restrict endpoint configuration to trusted administrators and enforce egress policy in Control. The client is not an SSRF filter.

TLS termination at a trusted reverse proxy is supported. Preserve the method, signed pathname, exact body bytes, and authentication header values passed to the handler. Do not rewrite paths, decompress bodies, or parse and reserialize JSON after signing. Reject ambiguous duplicate authentication headers at ingress; do not rely on forwarded headers to replace signed fields. Query strings are unsupported.

HMAC authenticates requests but does not encrypt them or authenticate responses. TLS remains necessary. Apply ingress rate, connection, header, and body limits; keep clocks synchronized. The SDK's body limit and request deadline complement those controls.

## Replay storage

Create one replay store per connection outside the request callback. `consume(requestId, expiresAt)` must atomically reserve the ID and return `false` for an existing unexpired claim. Retain claims until the supplied expiry, including future clock skew. Use a separate namespace per connection and fail closed when storage is unavailable.

`createMemoryReplayStore` is process-local and loses records on restart. Multiple workers, replicas, or serverless instances need a shared implementation. Use durable storage when replay protection must survive restarts. Do not replace it with a non-atomic read followed by a write, or shorten expiry to a fixed TTL measured from receipt. The SDK deliberately includes no database adapter.

## Rotating credentials

Each handler accepts one key ID and secret; overlapping keys are not supported. Plan a coordinated cutover:

1. Pause invocations for the connection and reconcile any in-flight mutations.
2. Generate a fresh secret and key ID. Update every SaaS instance and the Control connection through their secret/configuration systems.
3. Retire all old handler instances and invalidate the old secret. Keep replay records through their existing expiry.
4. Verify signed discovery with the new credentials, verify old credentials fail, then resume operations.

For a suspected compromise, disable access to the endpoint or remove the affected credentials immediately, before investigating. Do not offer an unsigned fallback during rotation. With the current single-key API, a brief interruption is preferable to accepting both keys through an unreviewed authentication wrapper.

## Deadlines and outcomes

Pass callback `signal` values to cancellable downstream work. A timeout or lost connection cannot establish whether a mutation committed and cannot roll it back. The SDK does not retry automatically; applications must reconcile uncertain outcomes and provide business idempotency where needed. Replay rejection only deduplicates an individual request ID.

Before deployment, test your own shared replay store, proxy path/body handling, log redaction, key rotation, and business callbacks. SDK tests do not verify those deployment-specific components.
