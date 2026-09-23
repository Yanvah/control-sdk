# Changelog

Notable user-facing changes are recorded here. Package versions and wire protocol versions are independent.

## 0.2.0 — Unreleased

- Protocol v2 adds opt-in `users.create` with email, optional name, and a validated created user result.
- New handlers retain v1 discovery and operations for older clients; clients default to v1 and can select v2 explicitly.
- SaaS handlers can report a sanitized `USER_ALREADY_EXISTS` conflict when no account was created.
- Clarified credential, replay-store, cancellation, and creation contracts in public types and documentation.

## 0.1.0 — Unpublished baseline

- Initial ESM-only TypeScript SDK for Node.js 22+, with root, server, and client entry points.
- Protocol version `1`, strict Zod validation, signed HMAC-SHA256 requests, bounded timestamps, body limits, and replay protection.
- Explicit user and subscription operations, custom actions, capability discovery, and sanitized error responses.
- Typed Control client with timeouts, cancellation, response validation, and no automatic retries or redirects.
- Process-local replay store and a public contract for shared atomic replay storage.
- Local Next.js example demonstrating two independently configured products and a signed smoke flow.
- Unit, security, integration, type, Next.js end-to-end, and packed-install tests.
- Deployment and contributor documentation, CI, and a manual npm Trusted Publishing workflow with provenance.

Repository and npm settings must be activated and verified before the first release; see [RELEASING.md](https://github.com/yanvah/control-sdk/blob/main/docs/RELEASING.md). No release date is recorded until publication.
