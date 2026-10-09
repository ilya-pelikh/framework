# Spec Delta

## Purpose

Обеспечить наблюдаемую и ограниченную по ресурсам эксплуатацию SSR islands, безопасную поставку релизов и проверяемый production-допуск на конкретной инфраструктуре.

## ADDED Requirements

### Requirement: Safe correlated diagnostics

Система SHALL различать timeout, disconnect, transport/HTTP, oversized body, protocol/identity/HTML, overload, render, browser import/hydrate/cleanup и integrity failures. Server-события SHALL содержать доступные request/module/release/slot/stage identifiers и длительность; browser-события SHALL содержать доступные module/release/island identifiers. Correlation между host и render service SHALL быть явной и валидируемой. Props, credentials, query strings и raw exception content SHALL NOT попадать в диагностику; ошибки diagnostic sink SHALL быть изолированы. Метрики SHALL использовать ограниченные labels без request ID.

#### Scenario: Failed render pipeline

- **WHEN** slot терпит отказ на конкретной стадии manifest/render/validation
- **THEN** оператор получает категорию, identity и duration для соответствующего отказа без пользовательских данных

#### Scenario: Diagnostic sink throws

- **WHEN** пользовательский диагностический обработчик выбрасывает исключение
- **THEN** обработка страницы, fallback и cleanup продолжаются согласно основному контракту

### Requirement: Bounded immutable manifest reuse

Система SHALL повторно использовать только полностью валидированные immutable manifests с согласованными module/release/URL/allowlist identity и конечными лимитами размера, количества и времени хранения. Общая in-flight загрузка SHALL сохранять независимые deadlines/cancellation потребителей. HTML, props и request context SHALL NOT кешироваться между запросами; ошибки загрузки SHALL NOT сохраняться как успешные entries.

#### Scenario: Concurrent consumers and cancellation

- **WHEN** два клиента запрашивают одинаковый manifest и один отключается
- **THEN** общий upstream fetch не дублируется и продолжает обслуживать второго клиента; при отсутствии всех потребителей ненужная загрузка отменяется

#### Scenario: Cache isolation and bounds

- **WHEN** изменился release/URL/allowlist либо достигнут configured cache limit
- **THEN** неподходящий manifest не используется, кеш остаётся в установленных пределах и запрос не получает данные другого релиза

### Requirement: Bounded admission and request work

Система SHALL иметь конечные валидируемые лимиты slots/request, global/per-module concurrency, queue capacity, aggregate response-byte reservations и HTTP request/header/body/keepalive timeouts. Ожидание admission SHALL входить в deadline слота. При перегрузке система SHALL быстро возвращать изолированный fallback с категорией overload, не создавая неограниченные очереди или автоматические retries. Резервации SHALL освобождаться при success/error/disconnect.

#### Scenario: Saturated module

- **WHEN** модуль исчерпал свою квоту запросов
- **THEN** новые слоты этого модуля получают overload fallback в пределах deadline; другие модули могут использовать оставшиеся глобальные квоты

#### Scenario: Response budget exhausted

- **WHEN** выполнение нового слота превысило бы configured aggregate body budget
- **THEN** слот не допускается к загрузке и не создаёт дополнительную неограниченную буферизацию

### Requirement: Finite process lifecycle

Запуск приложений SHALL иметь общий конечный deadline, ограниченные readiness-запросы и обработку раннего exit/error child. Остановка SHALL прекращать admission, отменять незавершённую работу и завершать принадлежащие orchestrator процессы в пределах configurable grace с последующим принудительным завершением зависших children. Посторонние процессы SHALL NOT завершаться.

#### Scenario: Hung readiness or child exit

- **WHEN** readiness endpoint не завершает ответ либо child завершается до готовности
- **THEN** запуск завершается контролируемой ошибкой в пределах общего deadline с cleanup своих children

#### Scenario: Shutdown with pending work

- **WHEN** поступает остановка при активном запросе или зависшем child
- **THEN** процесс прекращает новую работу, завершает или отменяет текущую и освобождает свои порты в пределах установленного grace и ограниченного принудительного завершения

### Requirement: Qualified deployment and retention policy

Production-поставка SHALL задавать поддерживаемый LTS runtime/toolchain, разрешённые install scripts, dependency audit/SBOM, доверенных авторов/publishers, права изменения registry, read-only published artifacts, HTTPS/CORS/CSP/nosniff/referrer policy и закрытый render-контур. Dev reload SHALL NOT присутствовать в production. Profile SHALL определять probes, rollout/drain, security-update process, retention не короче поддерживаемого page lifetime и rollback window, а также runbooks с владельцами. При пересечении trust boundary render SHALL требовать сервисную аутентификацию; CORS SHALL NOT считаться заменой контроля доступа.

#### Scenario: Production boundary verification

- **WHEN** проверяется deployment profile на целевой среде
- **THEN** разрешённый host загружает versioned assets с корректными headers, внешний недопущенный клиент не получает доступ к render-контуру, runtime не изменяет published artifacts и dev endpoint отсутствует

#### Scenario: Retention and rollback

- **WHEN** оператор проводит очистку либо откатывает registry
- **THEN** активные и защищённые retention-окном релизы сохраняются, rollback не требует rebuild соседей и существующая старая страница сохраняет доступ к своим delayed assets

#### Scenario: Runtime or dependency update

- **WHEN** обновляется pinned runtime или lockfile
- **THEN** комплект повторно проходит clean Windows/Linux и standalone acceptance, а версии и результаты проверки зависимостей сохраняются с артефактами

### Requirement: Evidence-based production qualification

Production-допуск SHALL относиться к конкретным commit/artifact digests и target environment. До измерений SHALL быть зафиксированы нагрузочный профиль, устройства/сети и пороговые значения server/browser budgets. Приёмка SHALL включать normal/burst/soak/outage/disconnect, долгоживущую страницу с cold delayed import, доступность controls с клавиатуры и rollout/rollback/interrupted-publication rehearsal. Результат SHALL содержать toolchain/platform versions, измерения, нарушения, непроверенные условия и ответственных; отсутствие необходимых параметров или evidence SHALL давать not-qualified.

#### Scenario: Missing target profile

- **WHEN** не заданы target environment, thresholds, workload, artifact identity либо владельцы приёмки
- **THEN** harness/отчёт не объявляет production-ready и перечисляет отсутствующие условия, даже если локальные функциональные тесты зелёные

#### Scenario: Completed qualification

- **WHEN** заданный профиль выполнен на целевой инфраструктуре, R1–R8 закрыты, все бюджеты соблюдены и rehearsal успешен
- **THEN** acceptance report фиксирует проверенные результаты и допускает только конкретный квалифицированный комплект

#### Scenario: Budget violation or failed rehearsal

- **WHEN** нарушен хотя бы один обязательный бюджет, старый delayed import не работает или rollback/recovery не проходит
- **THEN** production-допуск не выдаётся и сохраняются воспроизводимые данные отказа
