# Contributing

## Local checks

Use Node.js 22.13+ and npm. From the repository root:

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

Then run `npm run example:dev` and, in another terminal, `npm run smoke`. Stop the example before running type checking or building again. See the [example guide](./examples/nextjs/README.md) for its fixtures and generated-type compatibility handling. CI uses `npm ci` and checks Node.js 22 and 24.

Tests run without external services after dependency installation. Packaging tests install local tarballs into an isolated temporary project, with network access disabled in npm, and compile and execute the README integration. `npm run test:package` runs this portion separately. Temporary projects are removed after the tests.

## Changes and review

- Use strict TypeScript, platform APIs, and Zod at untrusted boundaries. Keep the three public entry points deliberate.
- Add behavior and type tests for public API changes, and direct rejection tests for security changes. Do not suppress failures or relax checks.
- Update affected docs, examples, and the changelog. Comments should explain non-obvious security or compatibility decisions.
- Keep dependencies, generated output, local credentials, and unrelated cleanup out of a pull request. `npm run format` applies repository formatting.
- Describe the problem, resulting behavior, validation performed, and any remaining limitations in the pull request.

Contributions are covered by the repository's Apache-2.0 license and [Code of Conduct](./CODE_OF_CONDUCT.md). Builds and package tests do not publish anything. Maintainers must follow [RELEASING.md](./docs/RELEASING.md) for an explicitly authorized release.
