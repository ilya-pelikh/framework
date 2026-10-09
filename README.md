# React SSR islands

Express server composition with independent React islands and immutable
microfrontend releases. Includes catalog and cart demos on separate origins.

Контекст для продолжения работы: [docs/CONTEXT.md](docs/CONTEXT.md).
Архитектура системы: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Use Node.js from your PATH and npm **11.19.1**. The project does not pin a Node.js version; CI uses the latest LTS.
Install the exact npm version with `npm install --global npm@11.19.1 --ignore-scripts`.
See [runtime policy](docs/runtime-policy.md) for runtime selection and clean verification.
Dependency scripts use a strict deny-by-default policy. After a clean build, run
`npm run security:report`; see [security updates and SBOM](docs/security-updates.md).
The [deployment profile](docs/deployment-profile.md) defines the private service
boundary; validate templates with `npm run deployment:validate -- deployment/profile.example.json`.
Production [HTTPS/CSP and browser checks](docs/browser-security.md) require that profile;
the local HTTP demo is not a production deployment. HTTPS tests require OpenSSL in PATH.
See [rollout, retention and manual cleanup](docs/rollout-retention.md) before retiring old releases.

```sh
npm ci
npm run dev
```

Open http://localhost:4100. Stop development with Ctrl+C. For production and checks:

```sh
npm run build
npm run start:demo
npm run typecheck
npm test
npx playwright install chromium
node --import tsx tests/build-smoke.ts
node --import tsx tests/build-browser-smoke.ts
```

See [development and deployment](docs/development.md), [HTTP protocol](docs/protocol.md),
[host configuration and rollback](docs/host.md), [browser lifecycle](docs/browser.md),
and [adding a third module](docs/extension.md).
Measured sizes, verification results and limits are in [acceptance results](docs/acceptance.md).
Production incident procedures are in [incident runbooks](docs/incident-runbooks.md).
See [qualification profiles and load harness](docs/qualification.md) for target inputs
and `npm run test:load`; a local smoke pass does not grant production qualification.

The fixture is independently built: it does not use the host, catalog, or cart.
The browser smoke check serves HTML on port 4310 and assets on 4311, verifies
server rendering, cross-origin imports of ESM entries and shared chunks, CSS,
and interactive hydration without console errors. Ports must be free.

## Release build API

`buildRelease` and `releaseConfig` are exported by `@islands/rsbuild`.
Pass `root`, `moduleId`, `releaseId`, `publicOrigin` (HTTP origin without a
trailing slash), `serverEntry`, and `islands` (key to browser source entry).
Optional `outDir` defaults to `dist`; relative paths resolve against `root`.
IDs use letters, digits, underscores and hyphens, start with an alphanumeric,
and have at most 64 characters. Builds refuse an existing release directory.
Choose a fresh release ID for every build, including retries after failed builds.
The fixture accepts `RELEASE_ID` in its environment for subsequent builds.

Outputs under `<outDir>/releases/<releaseId>/`:

- `server/server.mjs`: Node ESM server entry exports.
- `server/emitted-manifest.json`: complete emitted server output list.
- `assets/`: browser ESM entries, shared chunks within this module, CSS Modules,
  and Rsbuild's asset inventory (`assets/manifest.json`).
- `manifest.json`: immutable protocol manifest with emitted entry/CSS URLs and
  release identity. Every listed resource must exist before publication.
- `integrity.json` and `published.json`: complete file digests and publication identity.

Each output root belongs to one module. Builds exclusively reserve
`<outDir>/.reservations/<releaseId>`, compile under `<outDir>/.staging/<transactionId>`,
verify outputs and a callable renderer in a bounded subprocess, then atomically
rename to `releases/<releaseId>` on the same filesystem. Failed reservations remain.
The optional trusted `onStage(stage, directory)` build hook observes pre-publication
stages; throwing aborts the build. Validation still runs before promotion, including
after the `marked` hook. Do not use this hook to mutate published releases.
Legacy deployments require explicit [offline attestation](docs/release-migration.md).

Serve `assets/` at `/releases/<releaseId>/assets/` on `publicOrigin`. JS must use
a JavaScript MIME type; allow the host origin with CORS on entries and chunks.
Retain old release directories for pages that hydrate later. Never overwrite
published URLs. No React dependency is shared across microfrontend releases.

Production `npm start` requires an operator-managed `REGISTRY_PATH` or
`apps/host/dist/registry.json`. Builds only write `registry.sample.json`; they never
replace the live registry. `start:demo` explicitly selects the sample.
`ISLANDS_BUILD_ROOT` selects an alternate output tree for build/start. Development
uses isolated `.cache/dev/generation-*` trees and keeps serving the last successful
generation if compilation fails. A successful build precedes the short restart
and browser reload; no production release or registry is modified by dev.

The browser entry contract is `hydrate(element, props,
{identifierPrefix, onError})`, returning a `dispose()` callback. SSR and client
must use the same component, props and React version. The minimal build fixture
has no props or generated IDs and therefore only needs the element argument.
The host imports the entry URL; entry exports must remain ESM exports.

The adapter uses [Rsbuild's separate browser and Node environments](https://rsbuild.rs/guide/advanced/ssr).
