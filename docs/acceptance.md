# Результаты приёмки

## Production hardening — 2026-10-04 (промежуточно)

Change `production-hardening`: 46/53 задач. Это функциональная проверка,
**не production-допуск**. Node 24.21.0 LTS, npm 11.19.1, React/React DOM 19.3.0,
Playwright 1.63.0 / Chromium 153. Полный текущий статус и ограничения:
`PRODUCTION_HARDENING_STATUS.md`.

| Finding                                       | Named regression                                                 |
| --------------------------------------------- | ---------------------------------------------------------------- |
| R1: partial release ломает запуск             | `publication-faults.test.ts`, `readiness.test.ts`                |
| R2: fragment shadowing payload                | `fragment-hardening.test.ts`, `composition.e2e.ts`               |
| R3: два writer одного release ID              | `publication.test.ts`                                            |
| R4: неполная readiness                        | `integrity.test.ts`, `readiness.test.ts`                         |
| R5: inert/nested wrapper                      | `fragment-hardening.test.ts`, `composition.e2e.ts`               |
| R6: массивы с hooks                           | `json-hardening.test.ts`                                         |
| R7: cleanup, повторный dispose, DOM retention | `runtime-hardening.e2e.ts`                                       |
| R8: ложная проверка delayed import            | `cold-release.e2e.ts` (positive + entry/chunk negative controls) |

`npm test`: 75 тестов; `npm run test:hardening`: 18 browser/HTTP сценариев —
успешны на Windows и Ubuntu WSL. Новый cold-import тест доказывает ноль ранних
запросов выделенных entry/chunk v1, первый network import после v2 и локальный
отказ при блокировке каждого ресурса. Он заменяет прежний release smoke как
доказательство R8; прежний тест остаётся полезен для standalone deploy/rollback.

Windows и WSL прошли clean install/typecheck/unit/build/start/independent browser/
production/release/dev в новых isolated trees. Команды: `scripts/verify-windows.ps1`
и `scripts/verify-linux.sh`; пути staging и ограничения — в status report.
Remote GitHub Actions и target qualification **не выполнены**. CI содержит эту
матрицу с 20-минутным job deadline и upload безопасных artifacts при failure.

| Дополнительное условие I1–I5                                                                  | Evidence                                                                                                     |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Script-like/Unicode props без исполнения                                                      | `extension.e2e.ts`, `asset-failure.e2e.ts`                                                                   |
| Missing CSS/shared: admission/fallback и browser unavailable                                  | `asset-failure.e2e.ts` (3 режима)                                                                            |
| Invalid entry exports, malformed payload, SSR preservation                                    | `runtime-hardening.e2e.ts`                                                                                   |
| Нет раннего load/visible/idle/never import                                                    | `policies.e2e.ts`                                                                                            |
| Реальный redirect/disconnect/slow body/chunked overflow                                       | `upstream-network.test.ts`                                                                                   |
| Offline migration и rollback без sources/packages                                             | `migration-rollback.test.ts`                                                                                 |
| Failed launch/setup/hung setup, свободные порты, отсутствие secrets                           | `fixture-cleanup.e2e.ts`                                                                                     |
| Конечные startup/HTTP/shutdown, host drain                                                    | `process-lifecycle.test.ts` (6 тестов, задача 6.6)                                                           |
| Безопасные diagnostics, correlation, bounded labels                                           | `diagnostics.test.ts`                                                                                        |
| Immutable bounded cache и независимые single-flight consumers                                 | `manifest-cache.test.ts`                                                                                     |
| Admission/queue/body limits, overload/disconnect, рабочий сосед                               | `admission.test.ts`, `runtime-budgets.test.ts`, `evidence/runtime-smoke-windows.json`                        |
| LTS pins, lockfile, CI и standalone metadata                                                  | `toolchain.test.ts`, `runtime-policy.md`, оба clean verifiers                                                |
| Strict install policy, полные SBOM, audit failure/findings и hashes                           | `security.test.ts`, `security-updates.md`, `evidence/dependency-security-windows.json`                       |
| Deployment profile, private auth boundary, public assets, отсутствие утечек credentials       | `deployment.test.ts`, `deployment-profile.md`                                                                |
| HTTPS compiled target binaries, CSP positive/negative, headers/CORS и отсутствие dev endpoint | `security-headers.test.ts`, `https-policy.e2e.ts`, `browser-security.md`                                     |
| Retention fail-closed, source-free cleanup/drain, cold v1 и rollback без rebuild host/cart    | `retention.test.ts`, `retention-rehearsal.e2e.ts`, `rollout-retention.md`, `evidence/retention-windows.json` |

Оба clean verifiers выполнили реальный `npm run security:report`: audit 0 advisories,
SBOM и artifact inventory сформированы, gate `passed` при `productionQualified:false`.
CI сохраняет versioned dependency reports на 30 дней; remote workflow не запускался.
Boundary fixture использует реальный Node HTTP service/host, но не квалифицирует
reference NGINX, OS ACL/read-only mounts и TLS target infrastructure.
HTTPS fixture отдельно проверяет три compiled binaries за локальными TLS proxies
с test certificate; настоящий NGINX/CDN/public PKI остаётся target gate I8.
На этапе I7.4 Windows clean verification повторён отдельно после отказа проверки свободных
localhost-портов в параллельном Windows/WSL запуске; повтор прошёл полностью.
Полные verifiers запускайте последовательно из-за общих портов 4100–4103.
Текущий I7.5 прогон выполнен последовательно и прошёл обе платформы. Retention
rehearsal использует synthetic clock/policy; target page lifetime, rollback window,
distributed maintenance lock и approvals ещё требуют владельца среды перед I8.

Happy-path страницы проверяют console error/warning и pageerror через
`browserSession.assertHealthy` либо эквивалентные assertions, после interaction.
Это относится и к новой v2, и к rollback v1, а не только первоначальной странице.
Ожидаемые отказы import/render вынесены в отдельные сценарии с проверкой категории,
SSR и соседа. `test-evidence.md` описывает bounds/cleanup и безопасный структурный
trace: raw Playwright traces с DOM/props/credentials не записываются.

## Историческая приёмка — 2026-09-30

Изменение: `react-ssr-islands-microfrontends`, схема: `spec-driven`.
Зафиксированные версии инструментов: Node 26.10.0, npm 11.19.1, TypeScript 7.0.2,
React/React DOM 19.3.0, Express 5.2.1, Rsbuild 2.2.11,
плагин React 2.1.1, Playwright 1.63.0 / Chromium 153.

## Проверки

| Проверка                                                                      | Windows     | Ubuntu Linux (WSL)                        |
| ----------------------------------------------------------------------------- | ----------- | ----------------------------------------- |
| Чистая установка `npm ci`                                                     | Пройдена    | Пройдена в изолированной копии исходников |
| Проверка типов в корне и семи workspace-пакетах                               | Пройдена    | Пройдена                                  |
| Тесты контрактов, HTTP и проверки сборки                                      | Пройдено 12 | Пройдено 12                               |
| Production-сборки приложений                                                  | Пройдены    | Пройдены                                  |
| Собранный production-launcher и завершение процессов                          | Пройдены    | Пройдены                                  |
| Браузерные production-сценарии                                                | Пройдены    | Пройдены                                  |
| Независимое развёртывание, выпуск и откат                                     | Пройдены    | Пройдены                                  |
| Пересборка при разработке, автоматическая перезагрузка и завершение процессов | Пройдены    | Пройдены                                  |

Конфигурация GitHub Actions содержит задания Windows и Linux для этих проверок.
Команды выполнены локально в Windows и Ubuntu WSL; запуск на инфраструктуре
GitHub Actions из этого рабочего каталога не отправлялся.

Браузерные production-сценарии охватывают SSR с отключённым JavaScript,
CSS с отдельных origin, отключённые до гидратации элементы управления,
политики `load`, `visible`, `idle`, `never`, поведение при отсутствии браузерных API,
повторные независимые экземпляры и уникальные ID, повторный `bootstrap`,
освобождение активного корневого дерева и освобождение во время импорта,
сохранение SSR при ошибке импорта, локальное резервное содержимое при ошибке рендеринга
и работу корзины при недоступном каталоге.
В успешных сценариях не было ошибок страницы или консоли браузера,
включая диагностические сообщения об ошибках гидратации.

Тест релизов копирует только каталоги развёртывания во временное дерево
без исходников и `node_modules`. Он переключает каталог v1 → v2 → v1,
пока хост и корзина продолжают работать, проверяет неизменность хешей их сборок
и активирует остров `idle` на уже открытой странице v1 после перехода на v2.
Эта страница сохраняет HTML, props и URL ресурсов версии v1.

Тест разработки меняет в компоненте каталога Apple на Apricot, проверяет обновлённые
результаты SSR и клиентского рендеринга после автоматической перезагрузки,
затем восстанавливает исходник и реестр. Он останавливает управляющий процесс
и проверяет освобождение всех четырёх портов.

## Размеры браузерных ресурсов

Измерения выполнены для production-сборки v1. Размеры указаны в байтах;
размер после gzip измерен с помощью Node zlib.

| Ресурс                                 | Без сжатия, байт | Gzip, байт |
| -------------------------------------- | ---------------: | ---------: |
| Загрузчик островов хоста               |            1 559 |        795 |
| Точка входа каталога                   |            2 274 |      1 249 |
| Точка входа корзины                    |            2 079 |      1 152 |
| React chunk для каждого микрофронтенда |          218 337 |     68 782 |

React используется совместно точками входа внутри одного модуля,
но не разделяется между микрофронтендами.
Размеры точек входа не включают React chunk. Загрузчик хоста не содержит React.

## Полная локальная матрица 2026-10-06

Эта матрица выполнена до последующего упрощения ядра. Изменения и отдельные
результаты их проверки перечислены в [SIMPLIFICATION_REVIEW.md](SIMPLIFICATION_REVIEW.md);
source hash ниже не является хешем текущего состояния после ревью.

Clean Windows и Ubuntu WSL verifiers прошли на одинаковом source inventory
`a4b6fa1a9e93b0c333f01c7fcd3e869064d99948b50f0bff031b2a8686c764a1`:
Node 24.21.0/npm 11.19.1/Chromium 153.0.8010.12, 80 unit/HTTP tests,
18 hardening browser scenarios, отдельный load smoke с negative RSS control,
independent build/browser, production, source-free deployment/rollback, dev и
security report. Оба полных прогона завершились с exit 0.

Evidence: `evidence/verification-windows-2026-10-06.json`,
`evidence/verification-linux-2026-10-06.json` и перечисленные в них load reports.
Полные audit/SBOM сохранены в `.cache/verification-evidence/`; исходные логи —
`.cache/windows-2026-10-06-verification.log` и `.cache/linux-2026-10-06-verification.log`.
Linux evidence скопирована до завершения WSL, поскольку temp directories могут исчезать.
Git commit отсутствует. Target-профили, owner signoff и I8.3–I8.6 по-прежнему
открыты; результаты не предоставляют production-допуск. Remote CI не запускался.

## Локальная проверка I7.6 / I8.1–I8.2 (2026-10-05)

На Windows, Node 24.21.0, Chromium 153 прошли runbook fixtures (9 unit/HTTP и
3 browser), typecheck всех workspaces, пять unit tests qualification/load и
`npm run test:load`. Последний выполняет normal/burst/soak/outage/disconnect,
реальные HTTP/browser measurements и отрицательный RSS control во всех сценариях.
Missing telemetry, interrupted enter и deployment hash mismatch не дают pass.
Security fixture повторён вне sandbox после EPERM при подготовке npm lockfile.

Трассировка: `incident-runbooks.md` → host/registry/readiness/publication/security/
asset-failure tests; `qualification.md` → `qualification.test.ts`,
`load-harness.test.ts`, `load-harness.e2e.ts`. Evidence в
`evidence/load-smoke-windows.json` и `evidence/load-negative-windows.json`.
CI/verifiers включают отдельный load smoke. Нового Linux/remote CI прогона нет.
Target qualification I8.3–I8.6 открыта: короткий local soak и shared-process RSS
не являются целевыми measurements; оба load reports имеют productionQualified=false.

## Повторный запуск и ограничения

Выполните команды из `README.md` и `development.md`. Дополнительные проверки:

```sh
node --import tsx tests/start-smoke.ts
node --import tsx tests/dev-smoke.ts
```

Соберите каталог v2 с `RELEASE_ID=v2` (в PowerShell: `$env:RELEASE_ID='v2'`),
затем запустите `node --import tsx tests/deploy-release.e2e.ts`.
Идентификаторы релизов нельзя использовать повторно: для следующей сборки
нужны чистая копия проекта или новый ID.
Скрипт `scripts/verify-linux.sh` создаёт изолированную Linux-копию и запускает
полный набор проверок. В Linux нужны системные зависимости Chromium;
параметр `INSTALL_BROWSER_DEPS=1` явно включает их установку.

Проверен Chromium; Firefox и WebKit не проверялись.
В режиме разработки используется полная перезагрузка, старые релизы сохраняются.
Хранением и очисткой опубликованных релизов также управляет оператор.
Доверенный HTML рендерера не является изолированной средой.
Вложенные корневые деревья, потоковый рендеринг и Suspense, воспроизведение ранних событий,
аутентификация и общее состояние между корневыми деревьями не входят в v1,
как и предусмотрено проектированием.

Сборки для Node выдают предупреждения о неиспользуемом динамическом загрузчике
шаблонизаторов Express и необязательной зависимости `supports-color` пакета `debug`.
Проверки независимого развёртывания проходят; фреймворк не использует эти возможности.
npm сообщает о пропущенном необязательном скрипте установки esbuild;
зафиксированный бинарный файл для соответствующей платформы работает во всех описанных сборках.
