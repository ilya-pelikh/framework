# Dependency security и обновления

## Install scripts

Используется закреплённый npm 11.19.1. Root `package.json#allowScripts` содержит
`esbuild: false`; **разрешённых dependency install scripts сейчас нет**.
`strict-allow-scripts=true` в `.npmrc` делает новую непроверенную lifecycle dependency
ошибкой установки вместо молчаливого пропуска. Workspaces не задают собственную
политику. Нельзя обходить её через `--dangerously-allow-all-scripts`, environment
overrides или blanket `approve --all` в CI.

Решение для esbuild 0.28.2: postinstall `node install.js` не требуется проверенному
Windows/Linux комплекту, использующему platform optional package. Скрипт остаётся
запрещённым; это **не утверждение о безопасности его исполнения**. Не отключайте
optional dependencies. Если новой платформе требуется script, сначала review
содержимого tarball, integrity и сетевых/файловых эффектов, затем отдельный reviewed
pin `package@exact.version: true` и полный clean acceptance. Deny может быть
name-only; allow обязательно ограничивается точной версией.

Проверка: `npm install-scripts ls --json`. Механизм описан в
[официальной документации npm](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/)
и проверен по исходникам установленного 11.19.1. `tests/security.test.ts` использует
свой localhost tarball: непроверенный postinstall вызывает `ESTRICTALLOWSCRIPTS`,
явный deny позволяет установку, но marker исполнения не создаётся. Негативный
контроль проверяет конкретный error code, а не произвольный nonzero exit.

## Отчёты для build и bundled runtime

После **чистой** установки и сборки выполните `npm run security:report`.
Команда использует выбранный Node и npm CLI без shell, timeout 45 секунд на команду,
ограничение вывода 16 MiB. Каждый запуск создаёт новый `.cache/security/<time>-<uuid>/`:

| Файл                  | Содержание                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `report.json`         | schemaVersion 1, time/platform/Node/npm, lock SHA-256, результаты, digest каждого отчёта |
| `install-policy.json` | Политика и hashes root package / `.npmrc`                                                |
| `audit.json`          | Полный npm audit JSON v2 либо явный unavailable без raw errors                           |
| `build.cdx.json`      | CycloneDX 1.5: полный lock graph, dev/optional/peer включены                             |
| `runtime.cdx.json`    | CycloneDX 1.5: runtime dependency closure трёх apps                                      |
| `artifacts.json`      | Пути/размеры/SHA-256 собранных dist files и общий digest                                 |

Build SBOM покрывает каждый non-link `node_modules` entry lockfile, включая
platform variants, build tools и библиотечный код, попавший в standalone bundles.
Отсутствие компонента проваливает gate. Нельзя запускать audit только над пустым
deploy `package.json` или считать `npm audit --omit=dev` полным анализом bundle.
Полный audit выполняется по исходному lockfile с dev/optional/peer; список
workspace filters не применяется, поскольку он может исключить root dev tools.
Форматы и ограничения: [npm SBOM](https://docs.npmjs.com/cli/v11/commands/npm-sbom/),
[npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit/).

Runtime SBOM — консервативный dependency closure, не точная карта оставшихся после
tree-shaking байтов. Full build SBOM — дополнительный superset, поэтому advisory
не снимается на основании предположения «этот dev package не попал в bundle».
Artifact inventory связывает отчёты с конкретными bytes; scanner не доказывает
происхождение этих bytes из sources. Запускайте его в том же trusted clean CI job
и сохраняйте вместе с release provenance. npm audit не сканирует Node/OpenSSL,
ОС, vendored код вне npm и неизвестные уязвимости; это отдельные review/update gates.

`ISLANDS_BUILD_ROOT` задаёт дерево build artifacts, если оно отдельно от sources.
Сканируются coordinator и три app dist, включая старые сохранённые releases;
staging/reservation/attestation transaction directories не считаются опубликованными.
Symlinks/non-files и отсутствие обязательных binaries/metadata отклоняются.
Существующие релизы и inventory не изменяются. Не включайте secrets в deploy files.

CI запускает команду после acceptance и сохраняет отчёты обеих ОС на 30 дней
также при отказе. Перед expiry publisher переносит их в защищённое хранилище
release evidence на весь срок retention/rollback. Commit берётся из валидного
`GITHUB_SHA`; при отсутствии остаётся `null`, а не выдуманным revision.

`status: passed` означает только успешные перечисленные dependency checks.
`productionQualified` **всегда false**: target qualification I8, provenance,
security review и инфраструктурные условия этим не заменяются.

## Advisories и security update

Любая severity, включая low/info, блокирует gate. Сбой registry, timeout,
невалидный audit/SBOM, неполный состав, несовпадение pins или изменившийся lockfile
дают nonzero exit и `not-qualified`, не «0 vulnerabilities». Raw npm exception,
stderr и network credentials в отчёт ошибки не записываются.

Для каждого advisory security owner документирует ID/URL, затронутые версии и
artifact digests, reachability в server/browser/build, решение и его обоснование,
ответственного, дату/срок пересмотра и ссылку на проверку исправления. Непроверенные
advisories остаются открытыми. В этом gate **нет автоматических waivers**: даже
documented accepted-risk не делает красный gate зелёным. Изменение политики
исключений требует отдельного согласованного решения, а не редактирования отчёта.

1. Release/security owner проверяет upstream advisories и Node support/security
   releases до каждой поставки; при уведомлении об уязвимости начинает внеочередной review.
2. Зафиксировать affected artifacts и disposition; для критического инцидента
   остановить promotion, привлечь on-call/security owner и определить containment.
3. Обновить только необходимые exact pins и lockfile, пересмотреть новые scripts,
   не запускать автоматический `npm audit fix --force`.
4. Выполнить clean Windows/Linux verifiers с Chromium, standalone/rollback/dev и
   новыми audit/SBOM. Отрицательные fixtures должны оставаться чувствительными.
5. Опубликовать новые immutable IDs, сохранить старые protected assets, связать
   audit/SBOM с digests новой поставки; выполнить rollout/rollback и target gate.

Имена owners, escalation contacts, incident SLA и постоянное evidence storage
назначает владелец target environment до I8. Этот документ их не подменяет.
