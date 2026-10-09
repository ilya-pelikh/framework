# Deployment boundary — I7.3

## Профиль и область поддержки

`deployment/profile.example.json` — **reference**, не параметры реальной среды.
Строгая versioned schema реализована в `parseDeploymentProfile` (`@islands/server`);
лишние/пропущенные поля, HTTP origins, пустые owners/publishers, writable artifacts,
совпадение runtime с writer и отсутствие private/auth policy отклоняются.

Проверка: `npm run deployment:validate -- deployment/profile.example.json`.
Exit 0 означает корректную структуру; результат всегда `productionQualified:false`.
Копию с `purpose: target` заполняет владелец среды: реальные origins, peer IPs,
principals, absolute registry/secret paths и owner. Примерные имена/IP не являются
согласованными production values. Профиль не заменяет qualification profile I8.

Reference topology: отдельный HTTPS origin на модуль, публичен только versioned
`/releases/:id/assets/...`; manifest/render/readiness доступны только host peers
через ACL и service authentication. Один origin в manifest подходит browser и
server: доступ разделяется по paths и source addresses, wire protocol не меняется.
До сборки задайте правильный HTTPS `PUBLIC_ORIGIN`; не редактируйте уже published
manifests/inventory. Для изменения origin выпускайте новый immutable release ID.

## Запуск артефактов

Для **каждого отдельного** standalone `server.mjs` supervisor задаёт:

```text
DEPLOYMENT_PROFILE=/etc/islands/deployment.json
PORT=4101
```

Module process: `node /srv/islands/catalog/server.mjs`; host:
`node /srv/islands/host/server.mjs` (обычно PORT=4100); cart — свой PORT и каталог.
Target profile проверяется до listen, reference profile запрещён при запуске.
Host использует profile registryPath/moduleOrigins, module — profile hostOrigin;
оба слушают только `127.0.0.1`. Отсутствующие/невалидные secrets не допускают запуск.
Профиль и файлы secrets монтируются supervisor отдельно для каждого процесса:
moduleTokensFile каталога и корзины содержат разные токены.

Без `DEPLOYMENT_PROFILE` сохраняется прежний **demo/development режим без service
authentication**. Не выдавайте его за production deployment. Трёхпроцессный
`dist/start.mjs`/`start:demo` использует demo-style unauthenticated probes и не является
supervisor для этого профиля; production запускает отдельные binaries, как описано
здесь. HTTPS termination/ACL обеспечивает локальный proxy перед каждым binary.
Полные CSP/security headers и lifecycle/retention runbooks — следующие I7.4–I7.6,
этот инкремент сам по себе не завершает production-конфигурацию.

## Service credentials

Host secret JSON: объект `HTTPS origin → token`, ровно по одному ключу на
`network.moduleOrigins`. Module secret JSON: массив одного или двух tokens
(второй только на время ротации). Генерация: криптографически случайные **32 bytes**,
base64url; validator принимает 43–128 символов `[A-Za-z0-9_-]`, но не может проверить
энтропию строки. Не храните значения в Git, profile, registry, manifest или браузере.

Host передаёт только собственный `Authorization: Bearer ...` на точный origin
и canonical manifest/render path. Cookie/Authorization пользователя не копируются.
Redirect запрещён; даже другой разрешённый origin не получает соседний token.
`ServiceCredentials` хранит map в private field: обычная JSON-сериализация не
раскрывает его. Credentials не включаются в diagnostic events/metrics.

Module проверяет token до JSON body parsing, integrity work и renderer, сравнивая
фиксированные SHA-256 digests через timing-safe comparison. Missing/wrong/duplicate
Authorization даёт 401 с `no-store`. Правильный Origin, CORS либо X-Forwarded-For
не дают права render. Только GET/HEAD canonical assets остаются публичными;
probes, manifest и render требуют bearer. Authenticated manifest — `private`
cache-control; private proxy cache выключен. CORS относится лишь к assets.

Ротация: добавить новый token в module, затем переключить origin-bound token host,
проверить render/probes и убрать старый из module. Изменения файлов подхватываются
при контролируемом restart, не hot reload. Не сохраняйте старый token бессрочно.
Базовый bearer даёт все private endpoint permissions; выдавайте его только trusted
host/probe agent. При утечке отозвать token, проверить secret access и release logs.
HTTP credentials разрешены API только для loopback fixtures/local transport;
target schema допускает исключительно HTTPS module origins.

## Proxy и network policy

`deployment/nginx-module.example.conf` — reference для catalog, не готовый файл
целевой среды. Замените DNS/cert/key/upstream port и **точно** синхронизируйте
`allow` peers с `network.hostAddresses`. Для cart нужен отдельный vhost.
Доступ к upstream port с сети запрещён loopback bind и firewall; host peers имеют
egress только на configured module HTTPS endpoints. Runtime не получает ingress
из интернета напрямую. Не публикуйте renderer через другой service/ingress route.

Для private locations proxy сначала применяет `allow peers; deny all`, затем
передаёт Authorization на backend; backend независимо требует bearer. На assets
proxy удаляет Authorization/Cookie. Reference не доверяет X-Forwarded-For и не
использует `real_ip_header`: за load balancer потребуется отдельная проверка
доверенных proxy addresses и реального source-IP контроля. Не заменяйте ACL на CORS.
Семантика ACL: [NGINX access module](https://nginx.org/en/docs/http/ngx_http_access_module.html);
headers: [proxy_set_header](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header).

Перед поставкой оператор выполняет `nginx -t` с реальными certificates/config и
проверяет запросы из разрешённой и внешней сети, включая ложные forwarding headers.
В этой локальной приёмке проверяется Node HTTP boundary, **не работа реального
NGINX/firewall/TLS вашей среды**. Запись raw request/headers/body отключена в
reference access log; сборщик security событий должен отдельно исключать secrets.

## Publishers, registry и read-only runtime

| Principal               | Разрешённые операции                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Trusted publisher       | Build/reservation/staging/promotion новых immutable IDs; без изменения старых bytes      |
| Registry writer         | Атомарная замена выбранных release pointers после проверки readiness                     |
| Runtime                 | Чтение registry, binaries, published releases и своего secret; без записи в эти каталоги |
| Browser/external caller | GET/HEAD versioned public assets; без manifest/render/probes                             |

`storage.*: true` — проверяемая **декларация**, а не настройка ОС. Linux: отдельный
непривилегированный UID, read-only bind mounts releases/registry/binaries, отдельный
publisher namespace для записи, no write permission на родителей registry/release.
Windows: отдельная service identity и NTFS ACL Read/Execute для runtime, Modify
только соответствующим publisher/registry writer, без наследуемого runtime Modify
на parent directories. Secrets — Read только нужной identity и администратору;
runtime не должен иметь publisher/registry credentials. Не храните secrets в dist.

Перед I8 выполните попытки create/rename/delete под runtime identity на target
mount/ACL и зафиксируйте отказ, сохранив publication/registry change доступными
правильным writers. Validator не проверяет реальные identity, mounts, firewall или
доверенность CI publisher; нужны свидетельства владельца среды, не галочка JSON.
Релизы — trusted executable code, bearer не делает недоверенный renderer sandbox.

## Локальные регрессии

Обязательная операционная запись с probes/drain, page lifetime/rollback/retention
и безопасная ручная очистка: [`rollout-retention.md`](rollout-retention.md).
Эти target-specific параметры ещё требуют владельца среды; существующий JSON
validator не заменяет проверку этой записи перед I8.

HTTPS/CSP/CORS, TLS termination templates и browser staging fixture описаны в
[`browser-security.md`](browser-security.md). Production profile включает эти
headers; HTTP demo без profile не получает production-гарантий.

`tests/deployment.test.ts`: schema negatives, reference startup rejection,
invalid secrets, actual host→service authenticated SSR, public assets/CORS,
unauthorized probes/manifest/render, forged Origin/forwarding headers, wrong и
duplicate tokens, отсутствие client credentials/secret в response/diagnostics,
запрет redirect, отсутствие credential на соседнем origin, неизменность inventory.
Это дополняет, но не заменяет target network/ACL/TLS evidence I8.
