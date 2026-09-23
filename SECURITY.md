# Security policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/yanvah/control-sdk/security/advisories/new). Do not open a public issue or pull request containing exploit details, credentials, or customer data.

Include the affected version, runtime, a minimal reproduction with synthetic data, expected and actual behavior, and the security impact. Share only credentials generated for the reproduction. If real credentials were exposed, revoke them independently of the report.

The private reporting form must be enabled by a repository administrator before release. If it is unavailable, open a public issue asking only for a private reporting channel; include no vulnerability details. There is no guaranteed response time. Maintainers will coordinate investigation, a fix, and disclosure through the private report.

## Supported versions

`0.2.0` is prepared but unreleased. Report issues against the current source. After release, security fixes will target the latest `0.2.x`; older development snapshots have no maintenance commitment.

## Scope and deployment

Authentication bypass, replay acceptance, validation failures, credential leakage, and package integrity issues are in scope. The SDK cannot secure a compromised SaaS process, connection secret, administrator account, or registered callback.

Review the [deployment guide](./docs/DEPLOYMENT.md) and [threat model](./docs/THREAT_MODEL.md) before deployment. A passing test suite is not a security audit or a guarantee about an application's business logic.
