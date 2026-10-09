# Design

## Context

См. proposal.md. При обследовании найдены только `.agents/` и `openspec/config.yaml` со схемой spec-driven; исходников, package.json, тестов и существующих спецификаций нет. Пользователь выбрал расширяемый фреймворк с двумя примерами и независимыми сборками/развёртыванием. Следующие пути и API являются проектируемыми, а не существующими.

## Goals / Non-Goals

**Goals:** детерминированный SSR, изолированные острова, атомарная связка HTML и ресурсов релиза, добавление микрофронтенда через публичный контракт, работа из production-сборки.

**Non-Goals:** произвольное выполнение стороннего кода, вложенные острова, общий React context между roots, SPA-навигация, потоковый SSR/Suspense, автоматическое обнаружение компонентов, полноценный интернет-магазин и поставка инфраструктуры в облако.

## Decisions

### 1. Структура и расширение

TypeScript и npm workspaces: `packages/contracts`, `packages/server`, `packages/client`, `packages/rsbuild`; `apps/host`, `apps/catalog`, `apps/cart`. Публичные API: декларация острова (ключ, компонент, политика), декларация fragment renderer и создание Express host по таблице маршрутов/слотов и registry. Browser runtime предоставляет bootstrap и dispose. Пакеты содержат общие механизмы, приложения — UI и данные примеров. Данные страницы передаются JSON props, только явно разрешённые поля контекста пересылаются render-сервису; cookies и authorization автоматически не пересылаются.

Монорепозиторий удобен для совместного старта, но production host не импортирует исходники или server bundles микрофронтендов. Каждый app имеет самостоятельные build/start и deploy-артефакты. Альтернатива с общим bundle мешает независимым релизам.

### 2. Композиция по HTTP

Express host владеет документом и маршрутами. Каждый микрофронтенд — отдельный Express-сервис с SSR и статическими файлами. Host получает фрагменты параллельно по HTTP и встраивает их в негидратируемую оболочку. Начальный маршрут `/` содержит каталог, корзину и статический текст. Неизвестный маршрут — 404, ошибка shell — 500, отказ отдельного слота — 200 с его fallback и рабочими соседями.

Выбран HTTP-контракт вместо Module Federation: независимость обеспечивается границей сервиса и ресурсов, без загрузки удалённого Node-кода внутрь host и общего React singleton. Federation с Rsbuild технически доступна, но пользователь её не требовал; она усложняет согласование runtime для отдельных roots. Альтернатива iframe изолирует DOM, но затрудняет общую SSR-страницу и оформление.

### 3. Release manifest и протокол v1

Registry host — локальный JSON с атомарной заменой: `moduleId -> {releaseId, manifestUrl}`; host перечитывает его для каждого запроса, валидирует целиком и сохраняет последний корректный snapshot. Если при запуске корректного registry нет, readiness неуспешна. Один запрос использует один snapshot. URL разрешены только на origins из серверной конфигурации; входные параметры пользователя не задают URL. Redirects при fetch запрещены.

Неизменяемый manifest содержит `protocolVersion: 1`, `moduleId`, `releaseId`, versioned `renderUrl`, карту разрешённых `islandKey -> {clientEntryUrl, cssUrls}`, `reactVersion` для диагностики. Ответ проверяется runtime-схемой. Несовместимая версия протокола или несоответствие релиза приводит к fallback. Разные микрофронтенды могут иметь разные React версии, но server и client одного релиза собираются одной зафиксированной версией.

`POST /releases/:releaseId/render`: запрос `{protocolVersion, moduleId, releaseId, instanceId, props, context}`; ответ `{protocolVersion, moduleId, releaseId, html, islands}`. Каждый island descriptor содержит `{id, islandKey, props, policy, identifierPrefix}`. Wrapper в HTML имеет тот же `id`. `instanceId` генерирует host на слот и запрос, сервер добавляет локальный индекс. Host проверяет уникальность ID, наличие wrappers, разрешённые island keys и соответствие manifest. HTML фрагмента не содержит исполняемых scripts; доверенный renderer предоставляет только HTML и descriptors. CSS и script URLs берутся исключительно из проверенного manifest, а не из props.

Host устанавливает конечный timeout 1500 мс на слот (manifest + render), ограничивает manifest 64 KiB и render response 1 MiB, отменяет fetch при timeout/закрытии клиентского соединения. Таймаут и лимиты конфигурируемы. Поздний ответ не меняет документ. Повторных запросов в рамках страницы нет. Корректные immutable manifests можно кешировать по moduleId/releaseId; HTML и props между запросами не кешируются.

### 4. SSR и browser runtime

Каждый остров рендерится отдельным `renderToString` с уникальным `identifierPrefix`; серверные данные полностью подготовлены до рендера. Fragment API собирает статическую разметку и sibling wrappers; вложенные roots запрещены и диагностируются. Shell и статические участки не имеют browser React root.

Host добавляет CSS всех показанных фрагментов до body, включая `never`, и один JSON payload `application/json`. Serializer экранирует `<`, `>`, `&`, U+2028/U+2029; атрибуты экранируются отдельно. Разрешены только JSON props: циклы, функции, BigInt и undefined отвергаются с ошибкой слота. Секреты остаются в серверном контексте. Trusted HTML поступает только от настроенных сервисов; это не sandbox для недоверенных авторов.

Клиентский entry острова экспортирует `hydrate(element, props, {identifierPrefix, onError})`, возвращающий `dispose()`. Он включает свою совместимую пару React/ReactDOM и вызывает hydrateRoot. Host runtime React не содержит. Разделяемые chunks внутри одного микрофронтенда допустимы; React между микрофронтендами не разделяется. Так серверный и клиентский UI всегда создаёт одна версия компонента. Неизменяемые ESM entry/chunk URL поддерживают прямой import, корректный MIME и CORS для origin host; CSS Modules ограничивают имена стилей, глобальные resets принадлежат shell.

Политики: `load` запускается после bootstrap; `visible` — при первом пересечении viewport (при отсутствии IntersectionObserver — load); `idle` — requestIdleCallback с timeout 2000 мс (fallback setTimeout 200 мс); `never` — никакого import/hydrate. До триггера не загружаются JS модули отложенного острова. Import promise кешируется по entry URL, состояние hydration — по instance ID. Повторный bootstrap не создаёт новый root. Dispose отменяет ожидающие callbacks/observers, вызывает unmount для активного root и запрещает завершение уже начавшегося import на удалённом контейнере.

Ошибка импорта сохраняет исходный SSR HTML и помечает остров недоступным. Ошибка рендера после гидратации обрабатывается локальной error boundary с fallback, диагностикой module/release/island; остальные острова работают. Hydration mismatch регистрируется через onRecoverableError и считается провалом happy-path теста. Не обещается сохранение исходного DOM после ошибки внутри hydrateRoot. Интерактивные controls отложенных островов до hydration отключены; replay ранних событий не входит в v1.

### 5. Сборки и разработка

Rsbuild собирает browser ESM entries и Node output раздельно; build adapter генерирует release manifest по фактическим JS/CSS outputs и запрещает отсутствующие ресурсы. React plugin включён для обоих targets. Release ID передаётся сборке, публикуется в путях всех ресурсов и не переиспользуется. Конкретные совместимые версии Node, React, Rsbuild, Express и плагинов фиксируются при реализации в engines/package.json/lockfile после smoke-проверки, без незафиксированного `latest`.

Корневая `npm run dev` запускает три приложения кроссплатформенным orchestrator с ожиданием readiness и завершением дочерних процессов. Каждый сервис использует Express и Rsbuild dev middleware/API; изменение SSR-модуля обновляет server output, изменение client/server пары приводит к полной перезагрузке страницы. HMR с сохранением состояния через границы островов не требуется. `npm run build`, `npm start`, `npm test`, `npm run test:e2e`, `npm run typecheck` документируются. Production start использует только dist и runtime dependencies, без dev server.

Каталог демонстрирует фильтр (`load`), корзина — изменение количества (`visible`, расположена ниже viewport в демонстрации), дополнительный экземпляр — `idle`, статический блок — `never`. Примеры не обмениваются бизнес-событиями; повторные экземпляры имеют независимое состояние.

### 6. Верификация и диагностика

Contract tests проверяют версии, URL allowlist, размеры, serialization и release pinning. HTTP integration tests проверяют SSR/статусы, параллельные запросы, timeout и отказ сервиса. Browser tests проверяют страницу с отключённым JS, сеть до/после триггера, взаимодействия, повторные экземпляры, dispose, отсутствие hydration warnings, CORS и CSS из production build. Release test переключает только registry на catalog v2 без перезапуска или пересборки host, затем откатывает на v1; уже открытая страница v1 продолжает гидратацию v1.

Серверные structured logs содержат requestId, moduleId, releaseId, slot и категорию ошибки без props и credentials. Browser callback сообщает import/render/mismatch ошибки без отправки пользовательских данных во внешний сервис. `/healthz` проверяет процесс, `/readyz` — валидную конфигурацию и локальные артефакты; недоступность удалённого модуля не выводит host из readiness.

## Risks / Trade-offs

- Дополнительный HTTP hop и буферизация HTML → параллельные слоты, конечные deadlines; streaming оставлен за рамками v1.
- Несколько копий React увеличивают JS → отложенные imports и shared chunks внутри релиза; измерять размер каждого entry в build отчёте.
- Старый HTML может дожить до смены релиза → старые render endpoints и assets сохраняются; автоматическая очистка не входит в v1.
- Доверенный fragment HTML может повредить документ → контролируемые авторы, общий renderer и проверка структуры; произвольные плагины не поддерживаются.
- Асинхронная ошибка компонента может заменить его DOM → локальный fallback и диагностический callback, без обещания восстановления серверной разметки.

## Migration Plan

Миграции существующих данных нет. Сначала собрать и опубликовать оба микрофронтенда с versioned endpoints/assets, проверить health и render, затем запустить host с registry. Новый релиз публиковать рядом со старым; после smoke-проверки атомарно заменить registry. Откат — вернуть предыдущую запись, не меняя host. HTML отдаётся с `Cache-Control: no-store`; ресурсы релиза — immutable, URL не перезаписываются. В учебной поставке старые релизы сохраняются до ручной очистки; очистка требует отдельной политики срока жизни открытых страниц.

## References

- [Rsbuild SSR](https://rsbuild.dev/guide/advanced/ssr): отдельные browser/Node environments, custom Express server и manifests.
- [React hydrateRoot](https://react.dev/reference/react-dom/client/hydrateRoot): совпадение SSR/client markup, identifierPrefix и обработка ошибок.
- [Rsbuild Module Federation](https://module-federation.io/integrations/build-tool/rsbuild): рассмотренная альтернатива загрузки модулей.
- [Express static files](https://expressjs.com/en/starter/static-files/): публикация статических ресурсов приложений.
