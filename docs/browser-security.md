# Production browser boundary

`DEPLOYMENT_PROFILE` включает production headers в отдельных host/module
`server.mjs` **до** static, service auth и routes. Без profile запуск остаётся
HTTP demo, не production. `productionHeaders(moduleOrigins)` экспортируется для
собственных Express entrypoints; включать его нужно только за HTTPS boundary.
Origins — canonical HTTPS, без wildcard, path, userinfo или CSP/header injection.
Middleware копирует allowlist при создании.

## Policy

- CSP: `default-src 'none'`; script/style/img/font/connect разрешены только с
  `'self'` и перечисленных module origins. `base-uri`, `object-src`,
  `frame-ancestors` — `'none'`; `form-action 'self'`; `upgrade-insecure-requests`.
  Нет `unsafe-inline`, `unsafe-eval`, `data:` или wildcard. Module response
  использует тот же baseline без дополнительных origins.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Strict-Transport-Security: max-age=31536000`; без includeSubDomains/preload,
  поскольку владение соседними доменами не подтверждено.
- CORS assets: только точный profile `hostOrigin`, `Vary: Origin`, без wildcard
  и credentials. Manifest/render/probes остаются private с bearer auth;
  CORS не ограничивает прямой HTTP клиент и не заменяет authentication.
- `shell.css` — отдельный обязательный host asset. Исполняемых inline scripts,
  style blocks/attributes нет; inert `application/json` payload сохраняется.
  Новые trusted modules/shell должны соблюдать CSP, а не расширять её до unsafe.
- Reload собирается только с `ISLANDS_DEV_BUILD=1` в отдельный dev asset.
  `scripts/dev.ts` выставляет флаг при сборке изолированной generation.
  Production build вырезает reload branch; runtime environment его не включает.
  Dev binary с deployment profile отказывает при старте. Не публикуйте dev outputs.

## TLS termination

`deployment/nginx-host.example.conf` и `nginx-module.example.conf` включаются в
NGINX `http` context (содержат `map`). Для второго module vhost используйте уже
объявленную module map, не объявляйте её повторно. Замените домены, cert/key,
порты и private peer addresses; сначала выполните `nginx -t` в целевой поставке.
Host HTTP перенаправляется на **фиксированный** HTTPS origin; module HTTP
отклоняется. Bearer credentials разрешены только в исходном HTTPS запросе:
HTTP redirect не защищает уже переданный по HTTP secret.

Proxy пропускает upstream CSP, добавляет deny-all policy при собственном error
response и выставляет nosniff/referrer/HSTS через `always`, не дублируя headers.
Не удаляйте CSP/CORS/MIME на CDN; не добавляйте permissive CORS. Node upstream
слушает loopback; удалённый proxy требует отдельно согласованного защищённого
transport, а не открытия этого HTTP listener наружу. TLS сертификаты, обновление,
DNS, firewall и доступ runtime к trust store проверяет владелец среды перед I8.

## Воспроизводимая проверка

`node --import tsx --test tests/https-policy.e2e.ts` входит в `test:hardening`.
Нужны OpenSSL CLI в PATH и установленный Chromium. Fixture создаёт однодневный
localhost certificate, три TLS reverse proxies и отдельно собранные host/catalog/
cart binaries с target-profile **локального fixture**, не реальной среды.
Node получает test certificate через `NODE_EXTRA_CA_CERTS` до запуска процесса;
Chromium исключает certificate errors только для SHA-256 SPKI этого ключа.
Глобальное отключение TLS verification и установка CA в ОС не используются.
Это проверка TLS transport/CSP, не публичной PKI или настоящего NGINX.

Проверяются authenticated SSR, cross-origin React/CSS, работа load/visible
controls, отсутствие CSP violations/hydration warnings на happy path,
nosniff/referrer/HSTS на success/error, exact CORS и private 401. `/events` и
`/assets/dev-reload.js` дают 404 даже с попыткой включить reload через runtime env.
Отрицательный контроль добавляет inline script/style: оба блокируются CSP,
script не исполняется и CSS не применяется. Эти две ожидаемые violations не
смешиваются с happy-path проверкой. Private test key удаляется при cleanup.

Для I8 повторите browser acceptance на настоящих HTTPS domains/CDN с обычной
проверкой сертификатов, без fixture SPKI exception; сохраните headers/network
evidence и результаты `nginx -t`, HTTP redirect/rejection и private ACL checks.
Локальный результат не является production qualification.

Основания: [W3C CSP Level 3](https://www.w3.org/TR/CSP3/),
[Node: NODE_EXTRA_CA_CERTS](https://nodejs.org/api/cli.html#node_extra_ca_certsfile),
[NGINX headers](https://nginx.org/en/docs/http/ngx_http_headers_module.html),
[NGINX map](https://nginx.org/en/docs/http/ngx_http_map_module.html).
