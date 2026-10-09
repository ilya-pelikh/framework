# Design

## Context

См. `proposal.md`, `docs/TECHNICAL_REVIEW.md` и `docs/PRODUCTION_ROADMAP.md`. Сейчас `buildRelease` пишет прямо в конечный каталог, `service-entry.ts` импортирует каждую директорию releases, readiness проверяет только entry/CSS. Host проверяет HTML фрагментов по отдельности, runtime читает payload по одному ID и сохраняет сильные ссылки после dispose. Release E2E повторно использует уже импортированный load-entry для idle-острова. Нормальные Windows/Chromium-сценарии проходят; эти наблюдения не доказывают production readiness.

План объединяет восемь roadmap-инкрементов в один change по запросу пользователя. Основные спецификации и архив первоначального изменения не переписываются до sync/archive. Реализация и публикация не авторизованы созданием planning artifacts.

## Goals / Non-Goals

**Goals:** закрыть R1–R8 с регрессиями; обеспечить строгую изоляцию фрагментов, атомарную неизменяемую поставку, доказуемую локальную готовность, безопасный lifecycle и конечные эксплуатационные бюджеты. Сохранить старые versioned URL, HTTP protocol v1 и нормальную работу независимых React roots.

**Non-Goals:** недоверенный HTML sandbox, SPA/streaming/Suspense, общие React context/business state, автоматическое повторение ранних событий, публикация SDK, мультиверсионная React-матрица, автоматическое создание облачной инфраструктуры. Первоначально квалифицируются Windows/Linux и Chromium. Target-specific domains, мощности и SLO — параметры qualification profile, а не неявные значения разработчика.

## Decisions

### 1. Строгая граница fragment → document

`packages/server/src/render.ts` продолжает проверять каждый фрагмент; правила выделяются в общий HTML contract validator. Namespace `islands-` для ID и служебные `data-islands-*`/composition markers резервируются framework. Wrapper в inert content (включая template) не считается live root. Исполняемый script остаётся запрещённым; sanitizer для недоверенных авторов не вводится.

Host помечает границы каждого слота собственными уникальными comment markers и строит документ с включёнными parse5 source locations. Shell должен включать каждый сконфигурированный slot-string ровно один раз и сохранять его границы. Проверяются итоговые DOM ID, принадлежность wrapper своему слоту, payload, отсутствие вложенных/перенесённых roots и parser repair, нарушающего границы. Это ужесточение shell contract документируется как несовместимое с callbacks, дублирующими/удаляющими/разбирающими slot HTML.

Порядок разрешения коллизий детерминирован: framework и shell имеют приоритет, затем слоты в порядке конфигурации. Поздний конфликтующий слот заменяется его fallback; при конфликте фрагмента с shell отклоняется этот фрагмент независимо от DOM-порядка. Проверка повторяется не более числа слотов плюс один, заменяя отмеченные сегменты уже построенной оболочки, без повторного вызова пользовательского shell callback. Неатрибутируемая структурная ошибка или некорректный fallback/shell даёт безопасный 500, а не бесконечную коррекцию.

Альтернативы: проверка только `islands-payload` не закрывает межслотовые ID; wrapping каждого слота новым div ломает контекст таблиц и существующие CSS selectors. Markers сохраняют структуру нормальных фрагментов, но требуют отдельной проверки parser-repair fixtures.

### 2. JSON и bootstrap — отдельные проверяемые контракты

В `packages/contracts` массивы проверяются по own property descriptors без чтения accessors: допускаются стандартный Array prototype, штатный length и плотные enumerable индексные data-properties. Запрещены symbols, custom properties, accessors, переопределённая сериализация и нестандартный прототип. Существующие правила plain object/scalar/finite number сохраняются. User-defined getters и toJSON не исполняются валидатором. Proxy не становится поддерживаемым источником props; недоверенный JavaScript вне trust model.

Bootstrap проверяет единственный payload script с ожидаемым типом и array-schema, обрабатывает parse/shape failures безопасной диагностикой. Для явного массива descriptors независимые некорректные записи диагностируются, корректные продолжают обработку; duplicate ID нельзя гидратировать повторно. При нечитаемом payload SSR сохраняется, roots не создаются. Missing container, invalid entry export и синхронная hydrate failure различаются с сетевой import failure.

Альтернатива `JSON.stringify/parse` как валидатор запускает getters/toJSON и меняет данные; она не подходит. Wire payload сохраняет текущий формат.

### 3. Release transaction и неизменяемый deployment inventory

Выделить layout `<outDir>/.staging/<transactionId>`, `<outDir>/.reservations/<releaseId>` и `<outDir>/releases/<releaseId>`. Publication root выделяется одному moduleId. Reservation создаётся эксклюзивным mkdir без recursive после подготовки родителя; остаётся tombstone даже после failed build, сохраняя правило «новая попытка — новый ID».

Build outputs, protocol manifest и новый `integrity.json` создаются в staging. Inventory schema v1 содержит moduleId/releaseId, относительный путь, размер и SHA-256 каждого server/browser output и protocol manifest; исключает собственный файл и `published.json`, чтобы не было циклических digest. Включаются allFiles, shared/async chunks, CSS/media, server chunks. Пути ограничены release root, symlinks запрещены, файлы проверяются как regular files. `published.json` содержит identity, inventory schema version и digest inventory.

Перед публикацией серверный export `render` проверяется в изолированном Node subprocess с timeout; это проверка trusted release, а не sandbox. Чужие top-level side effects не должны зависнуть в build-процессе. Проверяются всё inventory и manifest. Полный staging переносится atomic rename на том же volume в отсутствующий target. Reservation и непустой published target исключают overwrite среди поддерживаемых writers. Читатели видят каталог только с согласованным marker. Publication через object storage описывается отдельно: immutable objects и commit pointer последним; provisioning storage не входит в задачу.

`service-entry.ts` загружает только опубликованные кандидаты. Unmarked staging/legacy-каталоги диагностируются, но не ломают запуск valid releases. Повреждённый marked release не обслуживается; valid соседи продолжают работать, overall service readiness = 503 до исправления/явного удаления плохой публикации. Ошибка одной загрузки не завершает процесс. Новые каталоги допускаются при запуске/явной перезагрузке списка; автоматический hot discovery не нужен.

Альтернативы: late `wx` для manifest защищает слишком поздно; удаление failed output не защищает от crash и конкуренции; изменение публичного manifest для inventory потребовало бы ненужной миграции wire protocol. Sidecars остаются локальным deployment-контрактом.

Уточнение offline migration, согласованное 2026-10-01: старые релизы без server output graph аттестуются только по полному expected inventory доверенного CI/build snapshot. Формат schema v1: moduleId/releaseId и files с path/bytes/sha256 для каждого существующего файла; server emitted manifest для старого snapshot необязателен. Оператор получает JSON и его закреплённый SHA-256 из доверенного канала вне проверяемого каталога. CLI не генерирует эталон из текущих deploy files и не считает сам digest доказательством авторства. До любой записи сверяются полный набор, identity и bytes/digests, затем callable renderer в bounded subprocess и повторная проверка bytes. Добавляются только новые metadata: отсутствующий server emitted manifest, attestation provenance, integrity и publication marker последним. Существующие файлы не заменяются. Аттестация выполняется offline одним writer с exclusive reservation; после прерванной записи оператор восстанавливает чистую копию из доверенного snapshot, а не запускает автоматический repair. Runtime по-прежнему не доверяет unmarked directory.

### 4. Readiness и целостность

`/healthz` отражает жизнь процесса. Module `/readyz` требует хотя бы один опубликованный валидный релиз и отсутствие невалидных marked releases; `/releases/:releaseId/readyz` возвращает 200 для проверенного, 503 для повреждённого опубликованного и 404 для неизвестного/неопубликованного релиза. Host readiness проверяет локальную конфигурацию/артефакты и не зависит от remote health.

Integrity проверяется до admission, при явной загрузке и периодически; результат кешируется на ограниченный `integrityCheckIntervalMs` (по умолчанию 30 секунд). Readiness с просроченным результатом ожидает единственную bounded revalidation; ошибка даёт 503. Обнаружение повреждения после admission гарантируется не мгновенно, а не позже следующей проверки; immutable read-only mounts остаются основной защитой от изменения файлов. Тесты используют короткий interval/явный refresh и проверяют не только entry, но и shared/async chunks.

Альтернативы: проверка только manifest URLs пропускает транзитивные ресурсы; пересчёт хешей на каждом probe создаёт лишнюю I/O нагрузку. Digest не является подписью доверенного автора: полномочия публикации обеспечиваются отдельно.

### 5. Lifecycle без удержания освобождённых roots

Active states хранятся отдельно от tombstones, scoped по Document. Для одного документа ID не переиспользуется. Cleanup каждого state выполняется не более одного раза; cancel и unmount изолируются независимо, обработка остальных states продолжается. В finally удаляются active state и сильные ссылки на DOM/root/callbacks. Tombstone содержит только ID, а Document scope хранится в WeakMap; глобальный dispose обходит только существующие active states.

Pending import проверяет disposed/connected после resolution; import cache остаётся URL-based и не содержит DOM. Диагностика cleanup содержит identity, но не сырое исключение. `data-hydrated` документируется как успешная передача управления entry; готовность controls по-прежнему определяется React commit/useHydrated, а не этим атрибутом.

Альтернатива полного удаления ID-state без tombstone допускает повторную гидратацию после dispose; сохранение целого state удерживает DOM. Tombstone ID растёт в течение жизни document; SPA и неограниченный повторный mount не являются заявленным режимом, но detached DOM удерживаться не должен.

### 6. Доказательная приёмка

Сохранить node:test и Playwright, выделив небольшие именованные fixtures/helpers. Delayed-only entry и его chunk имеют URL, не используемые load-островом; network assertions делятся на до/после switch. Негативный контроль блокирует v1 entry/chunk только после switch и должен обнаруживаться. Policy fixtures имеют отдельные entries; never проверяется по import calls и отсутствию root.

Тесты upstream cancellation наблюдают server socket/body closure, redirect target реально слушает отдельный localhost origin и считает запросы. Chunked oversize не имеет Content-Length; slow body проверяет общий deadline, а не только получение headers. Failure artifacts включают trace/console/network. CI ограничивает job/test deadlines и подтверждает cleanup даже при падении setup.

Проверки третьего модуля включают independent build и cross-origin hydration через публичные API. Package publishing и произвольные React-пары остаются вне заявленной поддержки: текущая совместимая пара фиксируется явно.

### 7. Диагностика, кеш и runtime budgets

В server/client вводятся ограниченные категории ошибок и диагностические hooks. Server события содержат request/module/release/slot/stage/category/duration; raw props, credentials, exception messages/stacks и query strings не логируются. Correlation ID передаётся отдельным согласованным заголовком, валидируется и не становится пользовательским контекстом. Метрики агрегируются по ограниченным labels, requestId не является label. Render service получает собственный diagnostic sink; exceptions самого sink изолируются.

Manifest cache хранит только полностью проверенные immutable manifests по `(moduleId, releaseId, manifestUrl, allowlist-generation)`, с LRU и finite TTL. Исходные ориентиры: 256 entries, 16 MiB, TTL 5 минут. In-flight promise объединяется; signal одного consumer отменяет только его ожидание, общий fetch прекращается после ухода последнего consumer либо собственного deadline. Failed responses не кешируются; HTML/props/context не разделяются между запросами.

Admission budgets задаются конфигурацией с проверкой положительных конечных значений: исходные defaults — 32 slots/request, 64 active fetch pipelines/process, 8/module, нулевая очередь, 64 MiB зарезервированных response bytes/process. Резервация учитывает manifest/render body до освобождения ответа, а не только активные sockets. Эти величины не обещают предел RSS: parser/React/string overhead измеряется отдельно. При исчерпании квоты слот быстро даёт fallback/overloaded; retry storm не создаётся. Deadline слота 1500 мс включает ожидание cache/admission; response limits сохраняются. Circuit breaker вводить только по данным нагрузочной квалификации, базовое ограничение нагрузки от него не зависит.

Альтернативы: неограниченный Map/concurrency не годятся для долгоживущего процесса; кеширование HTML/props нарушает изоляцию; привязка single-flight к signal первого request отменяет соседей.

### 8. Процессы, dev и production configuration

Orchestrator проверяет exit/error child, каждый readiness fetch получает deadline, общий startup timeout конечен. Shutdown сначала прекращает admission, отменяет незавершённые fetch, ждёт configurable grace (по умолчанию 10 секунд), затем завершает принадлежащие orchestrator дочерние процессы принудительно. Не затрагиваются посторонние процессы/занятые ими порты.

Dev builds используют отдельное дерево и собираются при работающем last-known-good сервисе; только успешно подготовленная пара server/client допускает handoff и reload. При build failure пользователь видит диагностику, предыдущая страница остаётся доступной; следующая корректная сборка восстанавливает цикл. Краткий controlled restart после successful build допустим, zero-downtime dev не требуется. Production registry — внешняя конфигурация; host build создаёт только sample registry и не перезаписывает действующий.

Production profile задаёт trusted authors/publishers, read-only release mount, allowed origins, внутренний render route, HTTPS boundary, CSP без dev reload, nosniff/referrer policy, resource limits, retention и shutdown values. Для демо inline styles выносятся в asset либо получают согласованный CSP hash/nonce. Периметр SSR закрывается reference reverse-proxy/network policy; при переносе через иной trust boundary profile требует сервисной аутентификации, не внедряя бизнес-login в framework.

LTS version и npm выбираются по официальному support status во время реализации и проверяются на обеих ОС; pins обновляются согласованно. CI dependency audit/SBOM и install-script allowlist относятся к build-процессу. Утверждать production профиль без квалификации конкретных артефактов нельзя.

### 9. Qualification как конечный gate

Новый versioned qualification profile содержит target environment, domains, artifact/commit identity, devices/network, load pattern, RPS/concurrency, payload/slot mix, длительность прогонов и thresholds p95/p99 latency, RSS/event-loop, fallback/hydration/browser-transfer budgets. Числа и владельцы фиксируются до измерений; отсутствующие значения дают `not-qualified`, а не default pass. Это отделяет реализацию harness от подтверждения готовности внешней среды.

Harness выполняет normal/burst/soak/outage/disconnect, delayed cold import через целевой asset origin, keyboard/labels/error UX и rollout/rollback/crash rehearsal. Документируются results, hashes, runtime/OS/browser versions, SLO violations и непроверенные условия. Для полного закрытия change нужны все I1–I8, включая target evidence; отсутствие доступа к инфраструктуре не превращается в галочку completion.

### Трассировка и порядок

| Этап                        | Находки                        | Основные зависимости                   |
| --------------------------- | ------------------------------ | -------------------------------------- |
| I1 contracts/document       | R2, R5, R6                     | Нет                                    |
| I2 publication/dev recovery | R1, R3                         | Нет                                    |
| I3 inventory/readiness      | R4                             | I2                                     |
| I4 lifecycle                | R7                             | I1                                     |
| I5 CI/acceptance fixtures   | R8 + регрессии R1–R7           | I1–I4; тесты создаются вместе с фиксом |
| I6 observability/budgets    | Эксплуатационные пробелы ревью | I1, I3                                 |
| I7 deployment policy        | Runtime/security/retention     | I2, I3, I5                             |
| I8 qualification            | Production evidence            | I5–I7                                  |

## Risks / Trade-offs

- Строгая HTML/shell-проверка выявит ранее допустимые custom shells → миграционные примеры и contextual parser fixtures, явный breaking notice.
- Atomic rename зависит от одного volume и writer permissions → staging рядом с release tree, эксклюзивная reservation, тесты Windows/Linux, отдельная object-storage процедура.
- Новый sidecar layout несовместим со старыми deploy copies → явная offline-аттестация до включения strict mode; публичные ресурсы не изменяются.
- Периодическая integrity validation добавляет I/O и оставляет bounded окно обнаружения → read-only artifacts, single-flight refresh, измерение startup/probe cost.
- Full-document parsing и memory reservations добавляют CPU/ограничивают concurrency → bounded inputs, нагрузочная проверка, параметры профиля; отсутствие гарантии жёсткого RSS-limit внутри Node.
- Большой change может быть реализован лишь частично → задачи сгруппированы I1–I8, каждый этап даёт проверяемый результат; change не архивируется до полного выполнения.
- Нет target-инфраструктуры и Git metadata в текущей копии → qualification остаётся открытой задачей до появления environment и commit/digest, локальные тесты не выдаются за production-допуск.

## Migration Plan

1. Добавить регрессии R1–R8 и согласованные правила contracts; обновить extension guide для reserved IDs/slot boundaries/dispose.
2. Ввести staging/reservation/inventory builder и explicit offline attestation tool для существующих complete releases. Аттестация проверяет весь существующий граф и render export, создаёт только новые metadata sidecars и не заменяет bytes старых manifests/assets/server. Неаттестованные каталоги в strict mode не обслуживаются.
3. На staging квалифицировать сохранённые v1 и новые v2; переключить module service на marked releases. Broken publication делает readiness неуспешной, но не выключает valid release endpoints.
4. Развернуть новый host/runtime с поддержкой unchanged wire v1 и отдельной production-конфигурацией; запустить cold delayed import/rollback tests до переключения registry.
5. Включить budgets, diagnostics и security/deployment profile; провести I8 на конкретных immutable artifacts.
6. Rollback UI — атомарно вернуть registry на сохранённый аттестованный релиз без rebuild. Rollback framework binaries — вернуть предыдущий проверенный deploy snapshot вместе с совместимой конфигурацией, сохранив release directories. Старые assets остаются до окончания установленного page lifetime/rollback window.

## Open Questions

Параметры I8, не меняющие выбранную архитектуру: адреса target-среды, ожидаемая нагрузка и thresholds, устройства/сети, срок жизни открытой страницы, имена ответственных и окна release rehearsal. Они заполняются в qualification/deployment profiles до запуска приёмки. Выбор версии поддерживаемого LTS проверяется по состоянию на момент реализации; конкретная patch-version сейчас не фиксируется предположением.
