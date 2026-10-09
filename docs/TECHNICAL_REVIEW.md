# Техническое ревью и проверка спецификации

Дата: 2026-10-01. Объект: текущая рабочая копия `react-ssr-islands-framework` 0.1.0.

## Вердикт

Проект реализует работоспособный прототип SSR-композиции с независимыми React-островами. Основные пользовательские сценарии проходят, включая запуск из самостоятельных артефактов, переключение registry и откат. Однако считать спецификацию полностью выполненной и выпускать эту версию в production преждевременно: выявлены два дефекта P1 и шесть замечаний P2, включая существенный пробел приёмочного теста релизов.

Главные блокеры: незавершённый релиз способен остановить весь сервис при следующем запуске; корректный по текущему валидатору фрагмент способен отключить гидратацию соседних модулей через конфликт DOM ID. Дополнительно не обеспечены конкурентная неизменяемость сборок и полнота проверки локальных артефактов.

Исправления и подготовка к эксплуатации разложены на инкременты в [PRODUCTION_ROADMAP.md](PRODUCTION_ROADMAP.md). Код runtime в рамках ревью не изменялся.

## Объём и доказательства

Проверены четыре основных спецификации в `openspec/specs`, все 15 требований и 32 сценария; прочитаны proposal/design/tasks архивного изменения `2026-09-30-react-ssr-islands-microfrontends`, исходники четырёх пакетов, трёх приложений, сборочные скрипты, тесты и CI. `openspec list --json` не обнаружил активных изменений; использована действующая спецификация, а архив — как дополнительное свидетельство проектных решений. Все 27 архивных задач отмечены `[x]`, но отметки не заменяют проверку поведения.

В предоставленном каталоге отсутствует `.git`; невозможно привязать выводы к commit SHA, проверить историю или получить git diff. Ревью относится к файлам, присутствовавшим на момент проверки.

| Проверка                                                   | Результат этого ревью                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `openspec validate --all --strict --json`                  | 4/4 спецификации валидны; это проверка документов, не реализации                            |
| `npm run typecheck`                                        | Успешно в корне и семи workspace-пакетах                                                    |
| `npm test`                                                 | 12/12 успешно                                                                               |
| `npm ci --fetch-retries=0 --fetch-timeout=15000`           | Успешно в изолированной копии исходников                                                    |
| Production build после чистой установки                    | Успешно, новый `RELEASE_ID=review-clean`                                                    |
| `npm run test:e2e`                                         | Успешно на исходных артефактах и на заново собранном `review-clean`                         |
| `tests/start-smoke.ts`                                     | Собранный launcher запускается и освобождает порты                                          |
| `tests/dev-smoke.ts`                                       | Пересборка, SSR/client-изменение, reload и cleanup проходят в изолированной копии           |
| `tests/deploy-release.e2e.ts`                              | Успешно, в том числе для заново собранных v1/v2; запуск staging без исходников/node_modules |
| `npm audit --json --fetch-retries=0 --fetch-timeout=15000` | 0 известных уязвимостей по ответу npm на дату проверки                                      |
| Дополнительные локальные воспроизведения                   | Подтвердили R1–R7; R8 установлен анализом тестового сценария                                |

Изолированная рабочая копия находится в `.cache/technical-review/project`. Первые сборки использовали существующие зависимости через родительский каталог; затем выполнена собственная чистая установка, повторены unit/typecheck/build и browser E2E нового релиза. Изменения исходника тестом dev-smoke происходили только в этой копии. Диагностические скрипты и результаты оставлены в `.cache/technical-review`; это временные материалы, а не часть постоянного тестового набора. Минимальные шаги воспроизведения приведены далее.

Окружение: Windows, Node 26.10.0, npm 11.19.1, установленный Playwright Chromium. Linux/WSL, Firefox/WebKit и GitHub Actions в этом ревью не запускались. Предыдущие результаты Linux в `docs/acceptance.md` не засчитывались как новая проверка. Нагрузочное тестирование и проверка реальной инфраструктуры/CDN не выполнялись.

Сборка сохраняет известные предупреждения `supports-color` и динамического require шаблонизаторов Express; проверенные способы запуска от них не ломаются. npm также сообщает о неразрешённом postinstall esbuild; использованный платформенный бинарник работает. Результат npm audit не является доказательством отсутствия уязвимостей в собственном коде.

## Находки по приоритету

P1 — исправить до production: отказ сервиса или нарушение межмодульной изоляции. P2 — исправить/закрыть проверкой до общего production-допуска: нарушение контракта, гонка, неполная диагностика готовности или недоказанная гарантия.

### R1 · P1 · Незавершённый релиз блокирует запуск всех релизов сервиса

**Места:** `packages/rsbuild/src/index.ts:58`, `scripts/service-entry.ts:8`, `scripts/dev.ts:23`.

`buildRelease` создаёт финальный `releases/<id>` до сборки. При ошибке компиляции или прерывании каталог остаётся без полного manifest/server/assets. Launcher безусловно читает и импортирует каждую директорию из `releases` до `listen()`. Одного такого каталога достаточно для необработанного исключения и exit 1, хотя предыдущие релизы исправны.

**Воспроизведение:** скопировать рабочий deploy-каталог с v1 во временное место, создать рядом `releases/unfinished/` без `manifest.json`, запустить `node server.mjs`. Получен exit 1 с ENOENT manifest. Существующая v1 перестаёт обслуживаться после этого запуска. Это воспроизводит состояние, которое может оставить прерванный build или частичная доставка артефактов.

В dev риск выше: предыдущие процессы останавливаются до пересборки, и следующий запуск снова сканирует оставшийся повреждённый каталог. Исправление исходника само по себе его не удаляет.

**Связь со спецификацией:** `Immutable assets and rollback`, `Independent release artifacts`, отказоустойчивость запуска. Документированное требование нового release ID после ошибки не устраняет проблему сканирования старой незавершённой директории.

**Исправление:** собирать в staging вне публикуемого дерева, проверять полный комплект и только затем атомарно публиковать; запускать только явно опубликованные релизы. Повреждение уже опубликованного релиза должно отражаться отдельной диагностикой и политикой readiness, а не незаметно игнорироваться. Добавить crash/restart-тест между стадиями публикации.

### R2 · P1 · Конфликт с `islands-payload` отключает гидратацию всей страницы

**Места:** `packages/server/src/render.ts:50`, `packages/server/src/host.ts:73`, `packages/client/src/index.ts:23`.

Валидатор проверяет ID только внутри отдельного фрагмента. Он не резервирует ID framework и не сопоставляет ID фрагментов с shell и соседними слотами. Bootstrap читает первый `getElementById('islands-payload')` и выполняет `JSON.parse` вне локальной обработки ошибок.

**Воспроизведение:** первый сервис возвращает `<div id="islands-payload">not-json</div>` перед своим обычным island-wrapper; второй слот возвращает корректный остров. Оба ответа проходят валидацию. HTTP-страница содержит два live-wrapper, но гидратировано 0/2; браузер сообщает `Unexpected token ... not-json ...`. Контрольная страница без конфликта гидратирует 2/2.

Фрагмент можно создать и через `builder.static`, поэтому проблема не требует внедрения script. Это дефект композиции доверенных модулей, а не утверждение о наличии sandbox для недоверенного HTML.

**Связь со спецификацией:** `Deterministic independent roots`, `Lifecycle and failure isolation`, структурная проверка ID из design. Ошибка одного автора выходит за границу его слота.

**Исправление:** резервировать namespace framework, проверять коллизии с shell и уже принятыми фрагментами до отправки документа; отказавший фрагмент заменять fallback. Для bootstrap проверять единственность и тип data-script и диагностировать ошибку payload. Добавить browser-тест с конфликтом framework ID и межслотовыми коллизиями.

### R3 · P2 · Две сборки одного release ID одновременно пишут в один каталог

**Места:** `packages/rsbuild/src/index.ts:58`, `packages/rsbuild/src/index.ts:60`, `packages/rsbuild/src/index.ts:98`.

Проверка `access(destination)` и `mkdir(..., {recursive:true})` не образует атомарную блокировку. Два вызова проходят проверку отсутствия каталога и запускают компиляторы в одну директорию. `flag: 'wx'` защищает лишь последнюю запись protocol manifest, когда server/assets уже записаны.

**Воспроизведение:** выполнить `Promise.allSettled([buildRelease(options), buildRelease(options)])` с одинаковыми options и новым release ID. В проверке обе сборки дошли до компиляции browser/server; одна завершилась успешно, другая — EEXIST только при записи manifest. Отказ «Release already exists» до компиляции не произошёл.

Использовались одинаковые inputs, поэтому фактическая смесь разных версий в этом опыте не доказывалась. Однако отсутствие эксклюзивного владения каталогом подтверждено: конкурентный writer может менять файлы, на которые уже ссылается успешный manifest.

**Связь со спецификацией:** `Immutable assets and rollback`, `Independent release artifacts`.

**Исправление:** эксклюзивная reservation release ID до компиляции и staging с публикацией без overwrite. В тесте конкурентных разных inputs ровно одна попытка получает право публикации; проигравшая не меняет ни одного байта победившего релиза.

### R4 · P2 · Readiness не проверяет весь исполняемый релиз

**Места:** `packages/server/src/service.ts:12`, `packages/server/src/service.ts:24`, `scripts/service-entry.ts:12`.

`/readyz` проверяет только доступность entry и явно перечисленных CSS. Shared/async chunks, другие файлы из build inventory и тип экспортированного `render` не проверяются. `access()` также не подтверждает, что ресурс является обычным файлом.

**Воспроизведение:** entry-файл существует и импортирует `./absent.js`, которого нет. Сервис возвращает readiness 200, а запрос к chunk — 404. Дополнительно зарегистрирован релиз с корректным manifest/assets, но `render: undefined`; readiness остаётся 200, render получает 500. Такой undefined может прийти из импортированного bundle без нужного export, несмотря на TypeScript-интерфейс вызывающего кода.

**Связь со спецификацией:** `Health and readiness / Invalid initial configuration` требует неуспешной готовности при отсутствии обязательных локальных артефактов. Проверка всех emitted assets при build полезна, но не обнаруживает неполную доставку или потерю chunk после build.

**Исправление:** сохранять и проверять полный asset inventory с размерами/хешами, проверять `typeof render === 'function'`, использовать проверку типа файла. Не смешивать локальную готовность с доступностью удалённых модулей: host по-прежнему должен быть ready при remote outage.

### R5 · P2 · Wrapper внутри `<template>` ошибочно считается доступным островом

**Места:** `packages/server/src/render.ts:65`, `packages/client/src/index.ts:27`.

Валидатор обходит `template.content` и засчитывает расположенный там wrapper. Но этот контейнер отсутствует в live document для `document.getElementById`. Bootstrap просто пропускает descriptor без диагностики.

**Воспроизведение:** вернуть `<template><div id="<instance>-0" data-island="counter">...</div></template>` с подходящим descriptor. Ответ принят сервисом и host. В проверке с двумя слотами гидратировался только соседний; fallback проблемного слота не появился, диагностик браузера нет.

**Связь со спецификацией:** `Versioned public contract / Contract mismatch`, проверка наличия wrappers и независимой гидратации.

**Исправление:** учитывать разницу между live DOM и inert content; отклонять island-wrapper внутри template и другие неподдерживаемые контексты. Проверять контракт по DOM, который действительно создаётся при вставке в документ. Отсутствующий контейнер в bootstrap должен давать структурированную диагностику.

### R6 · P2 · Валидация JSON допускает getters и `toJSON` на массивах

**Места:** `packages/contracts/src/index.ts:25`, `packages/contracts/src/index.ts:29`, `packages/contracts/src/index.ts:91`.

Объекты проверяются через property descriptors; массивы — через количество enumerable keys и `for...of`. Для массивов это вызывает getters и игнорирует собственные non-enumerable свойства. Неперечислимый `toJSON` с функцией проходит валидацию и исполняется сериализатором.

**Воспроизведение:**

```js
const values = [1]
Object.defineProperty(values, "toJSON", { value: () => ({ changed: true }) })
assertJson(values)
serializePayload(values)
```

Результат — `{"changed":true}`, хотя принят массив `[1]`. В отдельной проверке getter по индексу `0` был вызван валидатором; меняющийся getter дал `[3]` к моменту сериализации. Следовательно, успешный assert не гарантирует стабильные JSON-данные между SSR и client payload.

**Связь со спецификацией:** `Safe serializable props`, явный запрет getters/setters/functions в `docs/protocol.md`. Это относится к значениям, передаваемым автором через API, а не к обычному JSON, уже разобранному из HTTP.

**Исправление:** проверять собственные descriptors массивов, разрешая только обычные индексные data-properties и штатный `length`; запрещать extra properties/accessors/custom serialization и нестандартный прототип. Не запускать getters в процессе проверки. Добавить отрицательные тесты на эти варианты.

### R7 · P2 · Исключение в dispose прерывает cleanup соседей

**Места:** `packages/client/src/index.ts:14`, `packages/client/src/index.ts:17`, `packages/client/src/index.ts:57`.

`state.cancel()` и пользовательский `unmount()` вызываются без изоляции. Если callback первого острова бросает исключение, общий `dispose()` или disposer набора прекращает обход: следующий root остаётся активным, его callbacks не отменяются. Повторный dispose повторно вызывает тот же unmount, поскольку guard для уже disposed отсутствует.

**Воспроизведение:** два entry возвращают cleanup callbacks; первый бросает `Error('cleanup failed')`, второй увеличивает счётчик. После общего dispose получены исключение и счётчик 0.

Также Map сохраняет не только tombstone ID, но и `element`, `cancel` и `unmount`, которые удерживают DOM/замыкания до закрытия страницы. Это установлено по ссылкам в коде; величина удерживаемой памяти не измерялась. Для статичной короткой страницы эффект ограничен, для многократных mount/dispose он накапливается.

**Связь со спецификацией:** завершённость публичного lifecycle/dispose; изоляция исключений cleanup в сценариях спецификации явно не описана, поэтому здесь требуется и расширить сценарии.

**Исправление:** идемпотентный cleanup с `try/finally`, продолжением обхода соседей и категорией диагностики; после освобождения убрать сильные ссылки на DOM/root, отдельно сохранить минимальный признак «не создавать повторно». Проверить двойной dispose, исключение cleanup и очистку pending observer/timer.

### R8 · P2 · Release E2E не проверяет первый импорт старого релиза после переключения

**Места:** `tests/deploy-release.e2e.ts:24`, `tests/deploy-release.e2e.ts:34`, `apps/host/src/server.ts:14`, `packages/client/src/index.ts:38`.

Тест сначала ждёт гидратацию `load`-каталога v1, затем после переключения на v2 активирует `idle`-экземпляр того же каталога. Оба имеют один clientEntryUrl. Его entry и статические chunks уже загружены, а promise хранится в runtime cache. Успешная поздняя гидратация подтверждает повторное использование старого модуля из памяти, но не доступность старых ресурсов по сети.

**Недоказанная гарантия:** тест может остаться зелёным при удалении browser assets v1 после первой загрузки. Проверка отсутствия `/releases/v2/` не требует появления нового сетевого запроса `/releases/v1/` после deploy.

Похожее ограничение у idle/never-проверок `tests/production.e2e.ts`: одноимённый `load` entry уже импортирован, поэтому эти сценарии подтверждают отсутствие лишнего root, но не доказывают отсутствие раннего импорта отдельного entry. Visible-сценарий корзины использует другой модуль и в этом отношении сильнее.

**Связь со спецификацией:** `Delayed hydration across deployment`, `Hydration policies`, архивная задача 6.2.

**Исправление:** отдельный entry, существующий только у отложенного острова; до switch должно быть ноль его запросов. После switch первым запросом должен стать v1 entry и его chunk, с успешной гидратацией и взаимодействием. Дополнительно негативный тест: блокировка именно старого entry/chunk после switch должна приводить к локальному unavailable и тем самым доказывать чувствительность теста.

## Соответствие требованиям

«Подтверждено» означает подтверждение в проверенном Windows/Chromium-окружении. «Частично» означает известный дефект, неполное покрытие либо платформу, которую в этом ревью не запускали. Процент выполнения не вычисляется: зелёный happy path не эквивалентен исполнению всех условий SHALL.

| Требование                              | Реализация и тестовое свидетельство                                                             | Оценка                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Server composed document                | `server/src/host.ts`, `host.test.ts`, production E2E: SSR, CSS, 404/500                         | Частично: R2 нарушает целостность document/payload                                                                    |
| Bounded isolated fragment failures      | `server/src/fetch.ts`: общий signal для manifest/render, потоковый byte limit; host tests       | Механизмы есть; негативный HTML выходит за границу слота (R2), проверку фактического upstream disconnect усилить      |
| Request isolation                       | Request-local props/context, immutable registry object, тест alpha/beta, фильтрация credentials | Подтверждено в проверенных сценариях                                                                                  |
| Health and readiness                    | Host local files/registry, service entry/CSS checks, tests remote outage                        | Частично: R4                                                                                                          |
| Versioned public contract               | Contracts parsers, service routes, manifest identity, `validateFragment`                        | Частично: R5                                                                                                          |
| Atomic release selection                | `RegistryStore.snapshot`, frozen records, host берёт snapshot один раз, switch tests            | Подтверждено для проверенных переключений/last-known-good                                                             |
| Immutable assets and rollback           | Versioned directories/URLs, cache headers, release E2E                                          | Частично: R1, R3, R8                                                                                                  |
| Trusted origins and asset delivery      | Origins allowlist, fetch redirect:error, URL validation, MIME/CORS, browser imports             | Подтверждено для проверенных origins; отрицательные сетевые проверки можно усилить                                    |
| Hydration policies                      | Runtime load/visible/idle/never; production E2E, API fallbacks                                  | Реализовано; независимые idle/never imports недостаточно проверены (R8)                                               |
| Deterministic independent roots         | SSR identifierPrefix, useId, отдельные roots/state, nested guards                               | Частично: R2/R5; обычные повторные острова проходят                                                                   |
| Safe serializable props                 | JSON validator, escaped JSON script, attribute escaping, contract tests                         | Частично: R6; обычный JSON и script-like strings проверены                                                            |
| Lifecycle and failure isolation         | Import cache, root state, local error boundary, late import guard                               | Частично: R2/R7; основные import/render failures проходят                                                             |
| Reproducible development and production | Lockfile, pinned tools, build/start/dev, Windows smoke, standalone deploy                       | Windows подтверждён; Linux повторно не проверен; R1 ломает восстановление после неудачного build                      |
| Independent release artifacts           | Rsbuild server/browser, inventory checks, missing entry/CSS tests, module-only build            | Частично: R3; нормальная независимая сборка проходит                                                                  |
| Demonstration and extension guide       | Catalog filter/cart quantity, four policies, extension public API test                          | Демонстрация подтверждена; третий модуль в текущем тесте использует never, его browser integration отдельно не покрыт |

### Карта 32 сценариев

| Capability             | Сценарий                            | Свидетельство / недостающая проверка                                                                                                                                     |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ssr-composition        | JavaScript disabled                 | Production E2E: текст, начальное количество, CSS и disabled input                                                                                                        |
| ssr-composition        | Unknown route                       | `host.test.ts`: 404                                                                                                                                                      |
| ssr-composition        | Shell failure                       | `host.test.ts`: 500 без текста исключения                                                                                                                                |
| ssr-composition        | Timeout or invalid response         | HTTP-тесты timeout/status/size/version/release/origin; добавить chunked overflow и валидируемый HTML из R2/R5                                                            |
| ssr-composition        | Client disconnect                   | Тест видит category disconnected; не наблюдает закрытие запроса на upstream и прекращение передачи тела                                                                  |
| ssr-composition        | Concurrent differing props          | Параллельные alpha/beta и отсутствие cookie/authorization                                                                                                                |
| ssr-composition        | Remote unavailable                  | Browser E2E: catalog остановлен, cart работает, host readiness 200                                                                                                       |
| ssr-composition        | Invalid initial configuration       | Отсутствующий registry проверен; отсутствующий chunk/renderer выявил R4                                                                                                  |
| microfrontend-releases | Compatible module                   | HTTP composition и `extension.test.ts`                                                                                                                                   |
| microfrontend-releases | Contract mismatch                   | Parsers/host/render tests; inert wrapper не отклоняется (R5)                                                                                                             |
| microfrontend-releases | Release switch during request       | Manifest handler меняет registry; текущий ответ v1, следующий v2                                                                                                         |
| microfrontend-releases | Invalid registry update             | `registry.test.ts`: last-known-good и error callback                                                                                                                     |
| microfrontend-releases | Delayed hydration across deployment | Проверен warm import; cold network import не покрыт (R8)                                                                                                                 |
| microfrontend-releases | Rollback                            | v1 → v2 → v1 в отдельном staging, неизменные host/cart bundles                                                                                                           |
| microfrontend-releases | Untrusted endpoint                  | Allowlist/redirect rejection есть; `blockedHits` в host.test считает другой endpoint, чем redirect target, поэтому не доказывает отсутствие обращения к реальному target |
| microfrontend-releases | Separate asset origin               | Реальные cross-origin browser imports/chunks/CSS проходят                                                                                                                |
| islands-hydration      | Load policy                         | Production E2E: первый каталог становится интерактивным                                                                                                                  |
| islands-hydration      | Visible policy                      | До scroll нет cart JS, после scroll есть; fallback без observer проверен                                                                                                 |
| islands-hydration      | Idle policy                         | Удержанный callback, timeout 2000 и fallback без API проверены; отдельный entry не проверен                                                                              |
| islands-hydration      | Never policy                        | SSR/CSS и disabled input есть; нет root, но entry общий с load                                                                                                           |
| islands-hydration      | Repeated component                  | Разные useId, независимое состояние, нет happy-path console errors                                                                                                       |
| islands-hydration      | Nested declaration                  | `render.test.ts` отклоняет declaration/wrapper; отдельного HTTP-сценария nested → fallback нет                                                                           |
| islands-hydration      | Script-like string                  | Serializer round-trip и отсутствие raw HTML подтверждены unit-тестом; отдельного browser XSS-fixture нет                                                                 |
| islands-hydration      | Unsupported value                   | Cycle/function/BigInt/undefined и другие значения отклоняются; массивы с descriptors выявили R6                                                                          |
| islands-hydration      | Duplicate bootstrap and disposal    | Состояние сохраняется, pending import не гидратирует удалённый контейнер; cleanup-error и double-dispose не покрыты (R7)                                                 |
| islands-hydration      | Import failure                      | SSR сохранён, unavailable установлен, соседний cart работает                                                                                                             |
| islands-hydration      | Render failure                      | Error boundary даёт local alert, соседний каталог остаётся активным                                                                                                      |
| frontend-tooling       | Clean checkout                      | Чистая установка и dev-механика проверены на Windows в копии; Linux в текущем запуске не проверен                                                                        |
| frontend-tooling       | Production launch                   | Свежие build/E2E, compiled launcher, deploy без исходников/node_modules                                                                                                  |
| frontend-tooling       | Single module release               | Отдельно собран catalog v2, host/cart продолжают работать; concurrency требует R3                                                                                        |
| frontend-tooling       | Demonstration interactions          | Filter/count без reload, независимые повторные компоненты                                                                                                                |
| frontend-tooling       | Third module integration            | Public API + configuration HTTP fixture проходит; fixture без browser hydration                                                                                          |

## Архитектура и готовность к эксплуатации

У архитектуры есть полезные свойства: host не импортирует удалённый Node-код, версия фиксируется до композиции, входные данные сериализуются отдельно от HTML, запросы слотов параллельны и ограничены по времени/байтам. Framework-пакеты отделены от демонстрационных приложений. Маленький bootstrap не содержит React; независимые React roots действительно изолируют состояние.

Ниже — дополнительные работы для production, а не утверждения о нарушении исходного объёма v1.

- **Наблюдаемость:** почти все ошибки host сведены к `fragment-failed` (`host.ts:55`), render service возвращает общий 500 без диагностического callback. Не различаются timeout, HTTP status, protocol mismatch, size limit и structural HTML failure; нет duration/metrics/trace correlation. Это затрудняет поиск причины деградации.
- **Нагрузка:** для четырёх demo slots выполняются четыре manifest GET и четыре render POST, включая повторный manifest каталога. Нет single-flight/cache immutable manifests, ограничителя конкурентных render и circuit breaker. Каждый запрос полностью буферизуется и проверяется parse5; byte limits одного слота не ограничивают общую память при росте числа запросов.
- **Lifecycle процессов:** readiness-poll в `scripts/start.ts:24` использует fetch без отдельного AbortSignal; проверка 15-секундного deadline происходит только после завершения fetch. Stop ждёт exit без принудительного конечного срока. Нормальная остановка проверена, зависший процесс/долгий запрос — нет.
- **Release retention:** каждый retained server bundle импортируется при старте. Старые dev-релизы накапливаются; нужны политика удержания, пределы startup/RSS и отдельное хранение dev/prod. Удаление нельзя выполнять раньше согласованного срока жизни открытых страниц.
- **Browser budget:** около 68.8 kB gzip React chunk на каждый demo-модуль, плюс entry/CSS; загрузка обоих модулей требует двух копий React. Entry-size в одиночку скрывает стоимость транзитивного графа. Нужны бюджеты по всем ресурсам и измерения на целевых устройствах.
- **Граница доверия:** parse5-проверка не является sanitizer; в fragment HTML не фильтруются event attributes/произвольные resource elements. Это соответствует documented trusted-author модели. Для production нужно явно ограничить авторов/публикацию, задать CSP и сетевую политику render endpoint; CORS сам по себе не является аутентификацией.
- **Поддержка runtime:** зафиксированный Node 26 сейчас имеет статус Current, а не LTS. Перед production следует сертифицировать поддерживаемый LTS или дождаться перехода выбранной ветки и повторить проверки. [Официальная политика Node.js](https://nodejs.org/en/about/previous-releases) рекомендует production на Active/Maintenance LTS. Точный pin с `engine-strict=true` также требует процесса оперативных security upgrades.
- **Расширение экосистемы:** все пакеты private и экспортируют исходные `.ts`; server/client пакеты жёстко зависят от React 19.3.0. Workspaces работают, но перенос в отдельные репозитории и поддержка нескольких React-версий не доказаны. Нужны package-consumer fixtures и проверка одной совместимой пары React/ReactDOM внутри каждого релиза; не следует объявлять совместимость только по полю `reactVersion`.

Серверный и клиентский render действительно должны совпадать; React рекомендует считать mismatch ошибкой и требует одинаковый `identifierPrefix`. Это усиливает необходимость устранить R6 и расширить browser-fixtures. См. [официальный контракт hydrateRoot](https://react.dev/reference/react-dom/client/hydrateRoot).

## Что не является найденным дефектом

Отсутствие SPA-навигации, streaming SSR/Suspense, общего React context, replay ранних событий, бизнес-аутентификации и облачной инфраструктуры явно оставлено за рамками v1. Их нельзя считать невыполненной спецификацией. Неизменяемость release ID закономерно запрещает повторный build v1 в уже собранной копии; дефект R3 касается обхода этой защиты конкурентными сборками.

Итог допуска: основные функции реализованы, но требуются исправления R1–R7 и усиление приёмки R8. До их закрытия, повторной Windows/Linux-проверки и выполнения эксплуатационных критериев из roadmap production-допуск не подтверждён.
