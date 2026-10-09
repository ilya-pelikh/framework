# Spec Delta

## MODIFIED Requirements

### Requirement: Reproducible development and production

Проект SHALL предоставлять lockfile, зафиксированный поддерживаемый Node runtime, корневые команды dev/build/start/typecheck/test/test:e2e и отдельные build/start для каждого приложения. Dev SHALL запускать host и два модуля на Windows и Linux и завершать дочерние процессы при остановке. Dev outputs SHALL быть отделены от production-релизов; ошибка новой сборки SHALL сохранять доступность last-known-good приложения. Production build SHALL NOT перезаписывать действующую registry-конфигурацию; демонстрационная конфигурация SHALL поставляться отдельно.

#### Scenario: Clean checkout

- **WHEN** разработчик выполняет документированные установку и dev в чистой копии
- **THEN** доступны host и оба микрофронтенда, изменение исходников отражается после автоматического обновления страницы

#### Scenario: Production launch

- **WHEN** выполнены build и production start
- **THEN** страница работает из артефактов сборки без dev server, исходников и dev dependencies во время исполнения

#### Scenario: Development build failure and recovery

- **WHEN** изменение исходника ломает сборку, а следующее изменение её исправляет
- **THEN** во время неудачной сборки доступно предыдущее приложение, после успешной сборки страница обновляется без ручной очистки старых output directories

#### Scenario: Host rebuild preserves registry

- **WHEN** host собирается повторно при существующей deployment registry
- **THEN** её содержимое и выбранные версии не изменяются; sample registry создаётся отдельно

### Requirement: Independent release artifacts

Сборка микрофронтенда SHALL создавать согласованные server output, browser entries/chunks, CSS, manifest и integrity inventory одного releaseId. Она SHALL завершаться ошибкой при отсутствии заявленных ресурсов, некорректном renderer export или невозможности атомарной публикации. Весь комплект SHALL проходить проверку до publication; неуспешная проверка SHALL NOT менять уже опубликованные релизы.

#### Scenario: Single module release

- **WHEN** разработчик собирает новый релиз каталога
- **THEN** не требуется пересобирать host или корзину, release manifest ссылается только на существующие ресурсы этого релиза и его полный комплект проходит integrity-проверку

#### Scenario: Missing emitted asset or renderer

- **WHEN** отсутствует entry, CSS, shared/async chunk или server export не соответствует контракту
- **THEN** build завершается ненулевым кодом и новый релиз не публикуется

### Requirement: Demonstration and extension guide

Проект SHALL включать каталог с фильтрацией, корзину с локальным изменением количества, повторные экземпляры и демонстрацию четырёх hydration policies. Документация SHALL описывать добавление третьего модуля через публичные контракты, independent deploy/rollback, новые правила HTML/props/lifecycle, deployment migration и границы доверия. Проверка расширения SHALL включать независимую сборку и browser hydration с отдельного origin без изменения framework runtime.

#### Scenario: Demonstration interactions

- **WHEN** пользователь меняет фильтр каталога и количество в гидратированной корзине
- **THEN** оба интерфейса обновляются независимо без перезагрузки страницы

#### Scenario: Third module integration

- **WHEN** разработчик следует инструкции, независимо собирает совместимый третий модуль и регистрирует его и слот
- **THEN** модуль появляется через конфигурацию, загружает свои assets с разрешённого отдельного origin и становится интерактивным без изменения исходников framework runtime

## ADDED Requirements

### Requirement: Evidence-based automated acceptance

CI SHALL выполнять clean install/typecheck/unit/build/start/browser/release/dev на Windows и Linux с зафиксированным toolchain и заявленным Chromium. Приёмка SHALL включать отдельные regression scenarios R1–R8, независимые policy entries, реальные сетевые отказные проверки, конечные deadlines и cleanup принадлежащих тестам процессов. Happy-path hydration warnings и page errors SHALL приводить к провалу; при ошибке SHALL сохраняться доступные trace/console/network diagnostics без секретов.

#### Scenario: Cold release import and negative control

- **WHEN** тест открывает v1 со специально выделенным delayed-only entry, переключает registry на v2 и впервые активирует этот остров
- **THEN** assertions подтверждают отсутствие раннего запроса и успешные новые запросы entry/chunk v1; отдельный прогон с блокировкой старого entry/chunk обнаруживает локальный unavailable вместо ложного успешного результата

#### Scenario: Independent hydration policy entries

- **WHEN** тест удерживает idle/visible trigger и содержит отдельный never entry
- **THEN** эти entry не импортируются раньше своих триггеров, never не импортируется вовсе и shell не получает root

#### Scenario: Observable upstream isolation

- **WHEN** тест закрывает клиент, передаёт oversized chunked body или redirect на реально слушающий запрещённый origin
- **THEN** проверяются фактическое прекращение upstream чтения/соединения и ноль обращений к запрещённому target, а не только текст fallback или категория лога

#### Scenario: Failed test setup

- **WHEN** setup, browser launch, readiness либо тестовый сценарий зависает или падает
- **THEN** проверка завершается в пределах configured timeout, сохраняет диагностику и освобождает только свои процессы/порты
