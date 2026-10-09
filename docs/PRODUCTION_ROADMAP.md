# Инкременты до production

Дата основания плана: 2026-10-01. Основание: [техническое ревью](TECHNICAL_REVIEW.md). Номера R1–R8 относятся к его находкам. Это план следующих изменений, а не перечень уже выполненных работ.

Цель: выпускать совместимые микрофронтенды независимо, не повреждая действующие страницы, и диагностировать/ограничивать отказы в эксплуатации. План сохраняет HTTP-композицию, отдельные roots и отсутствие shared React singleton между модулями.

Предположение для первого production: доверенные авторы модулей, контролируемая публикация, закрытый render-контур, полноценные перезагрузки страниц. Если нужны недоверенные плагины или бизнес-операции с персональными данными, границы доверия и аутентификацию нужно отдельно спроектировать до допуска.

## Очерёдность

| Инкремент                                   | Приоритет      | Зависимости                         | Основной результат                                                                 |
| ------------------------------------------- | -------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| I1. Строгие контракты HTML и props          | Блокер         | Нет                                 | R2/R5/R6 закрыты, ошибка фрагмента остаётся в его слоте                            |
| I2. Атомарная публикация релизов            | Блокер         | Нет; выполняется параллельно I1     | R1/R3 закрыты, partial build не попадает в published releases                      |
| I3. Полная готовность артефактов            | Блокер         | I2                                  | R4 закрыт, ready означает наличие исполняемого комплекта                           |
| I4. Надёжный lifecycle браузера             | Обязательный   | I1                                  | R7 закрыт, dispose безопасен и освобождает ресурсы                                 |
| I5. Доказательная приёмка и CI              | Блокер         | I1–I4; fixtures можно начать раньше | R8 закрыт, холодная гидратация старого релиза и отказные сценарии проверяются в CI |
| I6. Диагностика и ограничение нагрузки      | Обязательный   | I1/I3                               | Ошибки различимы, работа ограничена при перегрузке                                 |
| I7. Безопасное production-развёртывание     | Обязательный   | I2/I3/I5                            | Поддерживаемый runtime, управляемые rollout/rollback, защита входных точек         |
| I8. Нагрузочная приёмка и release candidate | Финальный gate | I5–I7                               | Измеренные бюджеты, rehearsal и решение о допуске                                  |

Каждый инкремент оформлять отдельным OpenSpec change с delta requirements, дизайном, тестовыми сценариями и обновлением документации. Исправленные гарантии закрывать тестами в том же изменении. Перед архивированием проверять фактическую реализацию, а не только чекбоксы tasks.

## I1. Строгие контракты HTML и props

**Предлагаемый change:** `harden-fragment-and-json-contracts`. Ответственная роль: framework/server + browser reviewer.

**Работы:**

- Зарезервировать namespace ID framework, включая payload; определить правила ID для shell, static markup и островов.
- Проверять коллизии между принятыми фрагментами и shell; нарушивший контракт слот заменять fallback с адресной диагностикой.
- Не засчитывать inert template content как live island-wrapper. Уточнить допустимые HTML-контексты и проверять итоговый DOM для значимых parser-repair случаев.
- Ужесточить массивы в JSON validator: индексные data-properties, dense structure, стандартный прототип, запрет accessors/custom serialization/extra properties. Не выполнять пользовательские getters при валидации.
- Добавить проверку типа/единственности payload script и runtime-структуры browser descriptors. Некорректный вход должен давать диагностику, а не необработанный JSON.parse exception.

**Приёмка:** конфликт `islands-payload`, коллизия ID двух слотов и wrapper внутри template дают fallback только проблемного слота; соседний остров интерактивен. Getter массива не выполняется и отклоняется. Обычные массивы, `null`, scalar props и script-like strings сохраняются точно; SSR/client совпадают. Все существующие contract/browser tests остаются зелёными.

**Совместимость:** обычный существующий протокол v1 сохраняется; ранее принимавшиеся некорректные фрагменты начинают отклоняться. Reserved IDs и HTML-ограничения должны появиться в extension guide.

## I2. Атомарная публикация релизов

**Предлагаемый change:** `publish-releases-atomically`. Ответственная роль: build/release engineering.

**Работы:**

- Разделить staging и published directories. Ни build, ни partial upload не должны изменять опубликованный каталог.
- Эксклюзивно резервировать `(moduleId, releaseId)` до компиляции; проигравшая попытка не должна запускать writer в каталог победившей.
- Проверять server export, asset graph, manifest и контрольные суммы до публикации. Публиковать в пределах одного файлового тома с запретом overwrite; отдельно описать эквивалентный порядок для object storage.
- Дать loader явный источник списка опубликованных релизов/commit marker. Отдельно обрабатывать незавершённый staging и повреждение уже опубликованного релиза.
- Сохранять действующий dev-сервис до успешной сборки замены; ошибка новой сборки не должна требовать ручной очистки для восстановления dev.
- Разделить dev/prod outputs. Не перезаписывать действующий registry демонстрационным при обычном выпуске host; конфигурацию доставлять отдельно.

**Приёмка:** принудительное завершение build после создания staging, записи server, части assets и перед публикацией не нарушает последующий запуск старой v1. Две сборки с одним ID и различным содержимым дают одну публикацию; хеши победившего релиза не меняются. Старый render endpoint и assets доступны после публикации v2 и rollback.

**Откат:** registry возвращается на предыдущую опубликованную запись; артефакты v1 не пересобираются. Staging никогда не является целью registry. Проверить выбранную файловую процедуру и на Windows, и на Linux.

## I3. Полная готовность артефактов

**Предлагаемый change:** `verify-release-integrity-and-readiness`. Ответственная роль: server/build.

**Работы:**

- Хранить inventory всех emitted entry/shared/async JS, CSS, fonts/images и server artifacts с размерами/хешами.
- Проверять целостность при загрузке релиза и до его допуска; проверить `render` как вызываемый export и соответствие identity/manifest.
- Различать liveness процесса, local readiness и readiness конкретного релиза. Для host сохранить правило: удалённый outage не переводит локально исправный host в not-ready.
- Для заявленных локальных файлов проверять тип файла, границу каталога и отсутствие path escape. Задать политику symlinks.
- Не перечитывать большие asset trees на каждый health probe: кешировать результат для неизменяемой опубликованной версии с явной инвалидизацией при переключении.

**Приёмка:** удаление общего React chunk, async chunk или server export делает соответствующий релиз not-ready до переключения registry. Неверный checksum и directory вместо JS не проходят. Remote outage оставляет host ready, а слот переходит на fallback. Успешный build не заменяет этот deployment-тест.

**Совместимость:** решить, остаётся inventory deployment-sidecar или входит в wire protocol. В последнем случае явно версионировать обязательные поля и описать совместимость host со старыми манифестами.

## I4. Надёжный lifecycle браузера

**Предлагаемый change:** `make-island-disposal-robust`. Ответственная роль: browser runtime.

**Работы:**

- Сделать dispose идемпотентным; выполнять cleanup всех выбранных островов даже после исключения одного callback.
- Разделить active state и минимальный признак завершённого экземпляра; убрать сильные ссылки на DOM, root и callbacks после освобождения.
- Отменять idle/visible callbacks, не позволять позднему import создать root; добавить явные диагностические категории missing-container/entry-contract/cleanup.
- Разделить ошибку сетевого import и синхронную ошибку `hydrate`; уточнить, что `data-hydrated` означает, если React ещё не завершил commit.
- Зафиксировать поведение нескольких документов/повторной установки bootstrap либо явно ограничить API одним document на runtime instance.

**Приёмка:** exception в cleanup первого острова не оставляет второй активным; double-dispose не вызывает cleanup повторно; отключённый контейнер не гидратируется после import. Heap-проверка повторных mount/dispose не показывает удержание удалённых DOM через runtime state. Import failure сохраняет SSR, render failure остаётся локальным.

**Граница объёма:** SPA-навигация, повторное использование instance ID и автоматический retry import не добавляются без отдельного требования.

## I5. Доказательная приёмка и CI

**Предлагаемый change:** `strengthen-production-contract-tests`. Ответственная роль: test infrastructure + framework maintainers.

**Работы:**

- В release E2E добавить остров с уникальным delayed-only entry и зависимым chunk: первый сетевой import v1 происходит уже после переключения на v2.
- Сделать негативный контроль этого теста: блокировка старого entry/chunk после deploy должна обнаруживаться, а не маскироваться browser/runtime cache.
- Разнести load/idle/never по независимым entry для доказательства отсутствия ранних imports. Проверять вызов import отдельно от создания root.
- Добавить HTTP-тесты фактического закрытия upstream при disconnect, медленной передачи тела, chunked oversized response без Content-Length и общего deadline manifest+render.
- Для redirect/allowlist использовать реальный локальный запрещённый target со счётчиком запросов; его origin не включать в allowlist.
- Проверить malformed descriptors/wrappers через host → fallback, browser serialization с `</script>` и Unicode, отсутствующие shared chunks, ошибку CSS и неподдерживаемый entry export.
- Добавить browser consumer для третьего модуля, а не ограничиваться never/SSR fixture. Независимый build-smoke включить в CI с уникальными release IDs.
- Делить монолитные сценарии на именованные тесты/fixtures; сохранять trace, network log и console/page errors при падении. Полный test run должен иметь timeout и cleanup в отказных ветках.
- Оставить Windows/Linux matrix; добавить браузеры согласно заявляемой поддержке. Сравнивать серверные и браузерные проверки с таблицей сценариев в ревью.

**Приёмка:** все R1–R7 имеют регрессионное покрытие; намеренное удаление старого delayed-only entry ломает контрольный release-тест. В чистом CI проходят install/typecheck/unit/build/start/browser/release/dev. Happy-path hydration warnings и page errors делают job красным. Свежие результаты и ограничения записаны в acceptance document.

**Дополнительная проверка SDK:** если framework планируется использовать из других репозиториев, проверять установленный/упакованный package в отдельном consumer-проекте, без workspace symlinks. Для нескольких React-версий определить поддерживаемые пары и peer dependency policy, затем проверить SSR/hydration каждой пары; до этого не обещать такую совместимость.

## I6. Диагностика и ограничение нагрузки

**Предлагаемый change:** `add-observability-and-runtime-budgets`. Ответственная роль: server + эксплуатация.

**Работы:**

- Разделить ошибки на timeout, disconnect, transport, HTTP status, oversized body, invalid protocol/identity/HTML и render exception. Сохранить безопасные request/module/release/slot IDs без props/credentials.
- Передавать correlation ID из host в render-контур по явному allowlist. Добавить длительности manifest/render/composition и счётчики fallback/hydration failure; не использовать request ID как label метрики.
- Добавить ограниченный cache/single-flight immutable manifests с корректным ключом identity+URL, без кеширования пользовательских HTML/props. Не связывать общий fetch с signal одного произвольного потребителя.
- Ограничить concurrency, размер очереди и суммарную память/число слотов. При перегрузке быстро возвращать локальный fallback; не добавлять бесконтрольные retries.
- Задать пределы HTTP request/header/body/keepalive и конечный shutdown grace period. Readiness-fetch orchestrator должен иметь собственный deadline и обнаруживать hung child.
- Оценить circuit breaker для недоступного модуля по результатам нагрузки, сохранив изоляцию остальных модулей.

**Приёмка:** по одному диагностическому событию можно определить релиз, слот и категорию отказа без пользовательских данных. При остановке одного модуля, медленном upstream и превышении нагрузки соседние слоты остаются в установленных бюджетах. SIGTERM завершает процессы в пределах настроенного grace period, включая зависший запрос. Отмена одного request не ломает cache/single-flight другого.

## I7. Безопасное production-развёртывание

**Предлагаемый change:** `define-production-deployment-policy`. Ответственная роль: platform/release + security reviewer.

**Работы:**

- Выбрать и проверить поддерживаемый LTS Node на дату запуска; синхронизировать `.node-version`, engines, npm, CI и deploy metadata. Не менять версию без повторной standalone-приёмки. [Политика поддержки Node.js](https://nodejs.org/en/about/previous-releases).
- Уточнить разрешения install scripts, процедуру обновления lockfile и security patches. В CI выполнять dependency audit, сохранять SBOM/состав bundled dependencies и проверять provenance релизов.
- Зафиксировать trust model: кто может менять registry, публиковать manifests/assets и выполнять render-код. Права runtime на published artifacts сделать read-only.
- Разделить публичные assets и внутренний SSR endpoint сетевой политикой; при пересечении границы доверия добавить сервисную аутентификацию. Защитить render endpoint от неконтролируемого вызова и перегрузки.
- Проверить HTTPS/CORS для реальных domains, выставить подходящие CSP, nosniff и referrer policy. Согласовать inline shell styles и dev-only script с production CSP. Не включать dev reload endpoint в production.
- Настроить probes, rolling replacement и drain; новый релиз допускается после inventory/render/browser smoke и только затем переключается registry.
- Определить retention по сроку жизни открытых страниц и rollback window. Dev releases хранить отдельно; безопасная очистка учитывает активные и поддерживаемые старые версии.
- Подготовить runbook: недоступный модуль, corrupt registry, потерянный asset, rollback, восстановление publication state и проверка результата.

**Приёмка:** staging работает только с deploy artifacts и заданными runtime dependencies, без исходников/dev tooling. Проверен rollout при существующей странице v1, rollback без rebuild host/cart, запуск после прерывания публикации и отказ доступа к внутреннему render API извне допустимого контура. Registry update не перезаписывает ресурсы. Оператор проходит runbook по наблюдаемым сигналам.

**Граница объёма:** пользовательская аутентификация и бизнес-авторизация не добавляются в framework автоматически. Если production-приложение их требует, отдельный инкремент должен быть завершён до его запуска.

## I8. Нагрузочная приёмка и release candidate

**Предлагаемый change:** `qualify-first-production-release`. Ответственная роль: release owner вместе с владельцами предыдущих инкрементов.

Сначала зафиксировать профиль целевой нагрузки: число слотов, payload bytes, RPS/concurrency, долю повторных модулей, cold/warm cache, устройства и сети. Без этого нельзя обоснованно объявить capacity или выбрать абсолютные performance thresholds.

**Работы и измерения:**

- Измерить p50/p95/p99 TTFB/composition, event-loop delay, CPU/RSS, активные HTTP connections, fallback rate и recovery time.
- Прогнать normal load, всплеск, длительную нагрузку, один медленный/недоступный модуль и прерывание клиента. Сравнить с заранее утверждёнными бюджетами.
- Проверить deadline 1500 мс по умолчанию и разрешённый overhead под нагрузкой; синхронный SSR/parse5 не должен скрывать перегрузку за зелёной liveness.
- Считать browser budget по полному графу JS/CSS, включая React chunks, а не только entry. Измерять transfer, hydration latency, layout shifts и время до доступного управления на целевом устройстве.
- Проверить долгоживущую страницу, release switch и старые delayed imports на реальных asset origins/CDN, включая кеши и CORS.
- Проверить доступность controls: клавиатуру, label/description, состояние disabled до hydration и доступное сообщение при import/render failure.
- Выполнить rollback rehearsal и восстановление после неполной доставки. Сохранить конфигурации, версии, результаты и ограничения воспроизведения.

**Финальный gate:**

- Нет открытых R1–R8; все новые дефекты, влияющие на целевые сценарии, устранены или явно исключены из поддерживаемого контракта до выпуска.
- Чистые Windows/Linux CI и заявленные браузеры проходят; старые HTML действительно выполняют первый import своего релиза после deployment.
- Нагрузочные и browser-бюджеты согласованы до измерения и соблюдены; неизвестные характеристики не помечены как пройденные.
- Probes, безопасные диагностические события, dashboards/alerts и конечный graceful shutdown проверены.
- Определены владельцы релизов/инцидентов, доступы, retention, security-update и rollback-процедуры.
- Acceptance report относится к конкретному commit и immutable artifact digest; оператор подтвердил rehearsal на целевой инфраструктуре.

## После первого production

Streaming SSR, SPA-навигация, cross-island state/events, ранний event replay, Module Federation и sandbox недоверенных авторов не нужны для закрытия текущих находок. Их стоит планировать отдельными изменениями по реальной потребности, не задерживая исправления целостности релизов и контрактов.
