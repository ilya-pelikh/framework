#!/bin/sh
set -eu
verification_root=$(mktemp -d /tmp/islands-verification.XXXXXX)
printf 'Verification directory: %s\n' "$verification_root"
[ "$(npm --version)" = 11.19.1 ]
export PLAYWRIGHT_BROWSERS_PATH="$verification_root/browsers"
mkdir "$verification_root/project"
tar --exclude=node_modules --exclude=dist --exclude=.cache --exclude=.agents --exclude=.git -cf - . | tar -xf - -C "$verification_root/project"
cd "$verification_root/project"
node --version
npm --version
npm ci --fetch-retries=0 --fetch-timeout=15000
npm run typecheck
npm test
npm run build
node --import tsx tests/start-smoke.ts
if [ "${INSTALL_BROWSER_DEPS:-0}" = 1 ]; then
  npx playwright install --with-deps chromium
else
  npx playwright install chromium
fi
npm run test:hardening
npm run test:load
node --import tsx tests/build-smoke.ts
node --import tsx tests/build-browser-smoke.ts
npm run test:e2e
RELEASE_ID=v2 npm run build --workspace @islands/catalog
node --import tsx tests/deploy-release.e2e.ts
node --import tsx tests/dev-smoke.ts
npm run security:report
