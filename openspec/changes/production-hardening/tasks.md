# Tasks

Основание: `docs/TECHNICAL_REVIEW.md` (R1–R8), `docs/PRODUCTION_ROADMAP.md` (I1–I8), `design.md` и пять delta specs этого change. Выполненные задачи отмечены после локальной проверки; ограничения и вопрос миграции описаны в `docs/PRODUCTION_HARDENING_STATUS.md`. I1 и I2 допускают параллельную реализацию; I3 зависит от I2, I4 от I1, I5 интегрирует I1–I4, I6 зависит от I1/I3, I7 от I2/I3/I5, I8 от I5–I7. Тесты конкретного исправления создаются вместе с ним; группа I5 усиливает сквозную приёмку.

## 1. I1 — Контракты HTML, props и browser input (R2/R5/R6)

- [x] 1.1 Ужесточить массивы в `packages/contracts/src/index.ts` через property descriptors без вызова getters/toJSON; unit-тесты должны отклонять accessors, extra/non-enumerable/symbol properties, custom prototype и сохранять round-trip обычного вложенного JSON.
- [x] 1.2 Добавить общие правила reserved namespace и live wrappers в `packages/server/src/render.ts`; unit/HTTP fixtures должны отклонять `islands-payload`, служебные markers, template roots и nested wrappers с fallback своего слота.
- [x] 1.3 Реализовать атрибуцию slot boundaries и проверку итогового document в `packages/server/src/host.ts`; browser/HTTP-тесты должны подтверждать детерминированный порядок межслотовых ID-коллизий, приоритет shell/framework и интерактивность соседа.
- [x] 1.4 Ограничить повторную проверку документа и валидировать shell/fallback contract; fixtures с parser repair, duplicated/omitted slot и некорректным fallback должны давать контролируемый 500 без повторных вызовов пользовательского shell callback или бесконечного цикла.
- [x] 1.5 Добавить runtime-валидацию payload/descriptors и entry в `packages/client`; browser-тесты должны подтверждать сохранение SSR без uncaught exception при malformed payload и продолжение обработки корректных явных descriptors при локальной ошибке.
- [x] 1.6 Обновить `docs/protocol.md`, `docs/host.md`, `docs/extension.md` и `docs/browser.md` для reserved IDs, slot boundaries и JSON/input ошибок; выполнить примеры на третьем fixture-модуле и проверить отсутствие happy-path mismatch.

## 2. I2 — Атомарные релизы и восстановление dev (R1/R3)

- [x] 2.1 Добавить schema/validator локальных integrity/publication metadata с identity, relative paths, bytes и SHA-256; тесты должны отклонять path escape, symlinks, не-файлы, identity/digest mismatch и принимать полный комплект.
- [x] 2.2 Перевести `packages/rsbuild` на эксклюзивную reservation и staging вне releases; конкурентный тест с разными inputs должен допускать только одного writer, а повторное использование failed release ID отклоняться до компиляции.
- [x] 2.3 Формировать полный inventory browser/server outputs и проверять callable render в bounded subprocess до публикации; тесты на missing entry/CSS/shared/async chunk и отсутствующий/зависший render export должны завершаться ненулевым кодом без публикации.
- [x] 2.4 Реализовать publication marker и atomic same-volume promotion без overwrite; crash-injection между стадиями и хеширование старого релиза должны подтверждать запуск/неизменяемость v1 после каждой прерванной попытки на Windows и Linux.
- [x] 2.5 Изменить `scripts/service-entry.ts` на загрузку только marked releases с изоляцией ошибок кандидатов; интеграционный тест valid v1 + incomplete staging + corrupt marked v2 должен сохранять v1, выдавать диагностику v2 и оставлять процесс живым.
- [x] 2.6 Добавить явную offline-аттестацию старых release directories только по полному expected inventory доверенного CI/build snapshot с закреплённым SHA-256; тест должен доказывать создание sidecars без изменения хешей существующих manifest/server/assets, отказ без свидетельства/при несовпадении/неполном комплекте и отсутствие автоматического доверия к unmarked legacy directory.
- [x] 2.7 Разделить dev/prod outputs и изменить `scripts/dev.ts` на build-before-handoff; smoke-тест syntax error → исправление должен сохранять last-known-good страницу и автоматически восстанавливать reload без ручной очистки.
- [x] 2.8 Отделить sample registry от действующей deployment registry в build/start сценариях; тест повторного host build должен сохранять существующий registry byte-for-byte, а чистый documented demo launch работать с явно выбранным sample.
- [x] 2.9 Обновить build/deployment/rollback инструкции с layout, reservation, offline-аттестацией и порядком публикации для filesystem/object storage; пройти filesystem migration/rollback по инструкции в отдельном staging без исходников.

## 3. I3 — Полная local readiness (R4)

- [x] 3.1 Подключить inventory validation к admission модуля и выдаче manifest/render; тесты должны запрещать повреждённый release и продолжать отдавать исправные соседние releases.
- [x] 3.2 Добавить `/releases/:releaseId/readyz`, агрегированную module readiness и независимую host readiness; HTTP-тесты должны различать unknown 404, valid 200, corrupt 503, пустой published set 503 и remote outage при host ready 200.
- [x] 3.3 Реализовать bounded single-flight integrity refresh с интервалом 30 секунд по умолчанию и настраиваемым сроком; тест с коротким interval должен выявлять удаление/изменение shared/async chunk после admission и не засчитывать просроченную проверку как success.
- [x] 3.4 Проверить regular-file/path/symlink policy и runtime render export на deployment fixtures; некорректные типы файла, отсутствующий renderer и повреждённый digest должны исключать готовность до переключения registry.
- [x] 3.5 Документировать точный смысл health/module/release readiness, bounded detection window и probes; выполнить probe-примеры для valid/corrupt/remote-outage сценариев и сохранить ожидаемые статусы.

## 4. I4 — Browser lifecycle (R7)

- [x] 4.1 Разделить active states и document-scoped tombstones в `packages/client/src/index.ts`; browser-тесты должны подтверждать no-double-root, независимость одинаковых ID в двух документах и отсутствие повторного создания disposed instance.
- [x] 4.2 Сделать cancel/unmount идемпотентными и независимо изолировать их исключения; тест набора из двух островов должен подтверждать cleanup соседа после exception и один вызов каждого callback при double-dispose.
- [x] 4.3 Удалять DOM/root/callback references после dispose, сохраняя late-import guard; тесты pending import/observer/idle и heap-retainer проверка должны подтверждать отсутствие поздней гидратации и удержания detached DOM через active runtime state.
- [x] 4.4 Разделить browser categories import/entry-contract/hydrate/missing-container/cleanup, изолировать diagnostic callbacks и описать `data-hydrated`; browser fixtures должны подтверждать нужную категорию без props и независимое включение controls после commit.
- [x] 4.5 Обновить lifecycle/API examples в `docs/browser.md`; выполнить пример disposer набора и отдельного ID с throwing cleanup, повторным bootstrap и повторным dispose.

## 5. I5 — Сквозная приёмка и CI (R8)

- [x] 5.1 Добавить delayed-only entry и отдельный зависимый chunk в release fixture; E2E должен фиксировать ноль их запросов до switch и первый успешный network import v1 после switch v2 с рабочим взаимодействием.
- [x] 5.2 Добавить отрицательный контроль release E2E с блокировкой v1 entry и отдельно chunk только после switch; проверка должна видеть локальный unavailable, сохранённый SSR и работающего соседа, доказывая чувствительность теста к потере старых ресурсов.
- [x] 5.3 Разнести load/visible/idle/never по независимым entry в policy fixtures; assertions должны отдельно проверять import calls, network timing, fallback APIs, root count и отсутствие shell root.
- [x] 5.4 Усилить HTTP fixtures: реальный запрещённый redirect target со счётчиком, наблюдаемый upstream disconnect, slow body и chunked overflow без Content-Length; тесты должны проверять сетевые эффекты и общий manifest+render deadline.
- [x] 5.5 Добавить browser/HTTP интеграционные сценарии malformed wrappers, script-like props/Unicode, missing CSS/shared chunk и invalid entry exports; проверить локальность отказов, точность данных и отсутствие исполнения payload.
- [x] 5.6 Дополнить third-module fixture independent build и cross-origin interactive hydration без правок runtime; пройти обновлённый extension guide и проверить MIME/CORS/CSS и совместимость текущей pinned React-пары.
- [x] 5.7 Выделить именованные fixtures/helpers, ограничить test/setup deadlines и cleanup; намеренно упавший setup/browser launch должен оставлять свободными свои порты и сохранять доступные trace/console/network artifacts без секретов.
- [x] 5.8 Обновить `.github/workflows/ci.yml` для clean install/typecheck/unit/build/start/browser/release/dev, independent build-smoke и regression suite R1–R8 на Windows/Linux с Chromium; локально доступные команды должны проходить, недоступные платформенные прогоны отражаться как непроверенные до реального CI.
- [x] 5.9 Обновить `docs/acceptance.md` и карту сценариев по результатам I1–I5, указав версии и ограничения; проверить, что каждая R1–R8 имеет named regression и что happy-path hydration/page errors делают соответствующий job красным.

## 6. I6 — Наблюдаемость и ограничения работы

- [x] 6.1 Добавить общие ограниченные server error categories, stage/duration и callback для render service; тесты timeout/status/protocol/HTML/integrity/overload должны проверять identity событий, отсутствие raw input/exception secrets и изоляцию throwing sink.
- [x] 6.2 Ввести валидируемый correlation header host → service и метрики с bounded labels; concurrent-request тест должен сохранять correlation без смешивания props/credentials, а проверка labels исключать request ID.
- [x] 6.3 Добавить bounded manifest LRU/TTL cache и immutable identity/allowlist key; тесты eviction, limits, release switch, rollback и invalid manifests должны подтверждать отсутствие stale identity и HTML/props caching.
- [x] 6.4 Реализовать single-flight manifest requests с независимым cancellation consumers; тесты должны подтверждать один upstream fetch, сохранение второго consumer после отмены первого и отмену upstream после последнего consumer.
- [x] 6.5 Ввести validated slots/concurrency/global/per-module/queue/body-reservation budgets с defaults из design; тесты перегрузки должны подтверждать bounded counters, быстрый fallback, освобождение reservation при всех исходах и доступ соседей к оставшимся квотам.
- [x] 6.6 Настроить конечные HTTP/header/body/keepalive limits, readiness-fetch/startup deadline и graceful/forced shutdown принадлежащих child processes; hung endpoint/child и long-request smoke должны завершаться за configured сроки без остановки постороннего процесса.
- [x] 6.7 Документировать категории, correlation, cache/budget defaults, метрики и shutdown hooks в эксплуатационном руководстве; выполнить diagnostic/load smoke и сохранить примеры безопасных событий и поведения overload.

## 7. I7 — Production deployment policy

- [x] 7.1 На дату реализации проверить официальную LTS support policy, выбрать совместимую runtime/npm пару и согласованно обновить pins/CI/deploy metadata; clean install/typecheck/build и standalone browser acceptance должны пройти на Windows/Linux.
- [x] 7.2 Зафиксировать install-script allowlist и security-update процедуру, добавить dependency audit/SBOM для bundled runtime/build состава; CI fixture должен выдавать versioned отчёты, а непроверенные advisories не считаться закрытыми без documented disposition.
- [x] 7.3 Подготовить валидируемый deployment profile и reference network/reverse-proxy configuration: trusted publishers, registry permissions, read-only releases, публичные assets и закрытый render-контур; локальный boundary fixture должен разрешать host и отклонять недопущенного клиента, включая auth-policy при пересечении trust boundary.
- [x] 7.4 Ввести production HTTPS/CORS/CSP/nosniff/referrer policy и убрать dev reload/несогласованный inline content; browser staging test должен проходить без CSP violations и проверять отсутствие production dev endpoint.
- [x] 7.5 Документировать probes, rollout/drain, retention/page lifetime/rollback window и безопасную manual cleanup процедуру; rehearsal fixture должен сохранять защищённые v1 assets, cold delayed hydration и rollback без rebuild host/cart.
- [x] 7.6 Подготовить runbooks с ролями/эскалацией для remote outage, corrupt registry, missing assets, partial publication и security update; пройти локальные воспроизводимые сценарии и явно выделить target-specific параметры, которые заполняются до I8.

## 8. I8 — Qualification и production gate

- [x] 8.1 Реализовать schema, пример и валидатор qualification profile с environment/commit/digests/workload/devices/network/thresholds/owners; тесты неполного профиля должны выдавать not-qualified и не подставлять фиктивные production thresholds.
- [x] 8.2 Добавить воспроизводимый load harness normal/burst/soak/outage/disconnect с server latency/event-loop/RSS/connections/fallback measurements и browser transfer/hydration/CLS; smoke harness должен выдавать машинно-читаемые результаты и корректно проваливать заведомо нарушенный budget.
- [ ] 8.3 Зафиксировать с владельцем целевой среды qualification/deployment profiles до измерений, включая domains, RPS/concurrency, длительность прогонов, SLO, retention, устройства и ответственных; артефактом завершения является заполненный валидный профиль, отсутствие этих данных оставляет задачу открытой.
- [ ] 8.4 Выполнить normal/burst/soak/outage/disconnect на конкретных target artifacts и сравнить измерения с заранее зафиксированными budget thresholds; сохранить результаты, toolchain/platform versions и причины любого not-qualified результата.
- [ ] 8.5 На target asset origin/CDN проверить долгоживущую v1 с первым delayed import после v2, keyboard/labels/disabled/error UX и rollout/rollback/interrupted-publication recovery; сохранить browser/network evidence и протокол rehearsal с владельцем среды.
- [ ] 8.6 Выполнить финальную интеграционную приёмку Windows/Linux/Chromium, сопоставить все изменённые requirements/scenarios с тестами и измерениями, записать acceptance report с commit/artifact digests; не отмечать change завершённым при открытых R1–R8, пропущенных обязательных условиях или непрошедших бюджетах.
