# Протокол v1

Пакет `@islands/contracts` проверяет реестр, манифест и сообщения рендеринга во время выполнения.
Реестр хоста сопоставляет идентификаторам модулей записи `{releaseId, manifestUrl}`.
Манифест содержит `protocolVersion: 1`, `moduleId`, `releaseId`, `reactVersion`,
`renderUrl` и `islands: { [key]: {clientEntryUrl, cssUrls} }`.
Все URL рендеринга и ресурсов включают `/releases/<releaseId>/`.
Каждый релиз публикуется один раз; предыдущие релизы необходимо сохранять.

Функция `createModuleService({releases, allowedHostOrigins})` из `@islands/server`
предоставляет манифест, каталог ресурсов и серверный рендерер каждого релиза:

- GET `/releases/v1/manifest.json`: неизменяемый манифест.
- POST `/releases/v1/render`: запрос и ответ в JSON; кеширование запрещено через `no-store`.
- GET `/releases/v1/assets/*`: неизменяемые файлы. MIME-тип определяется по расширению,
  а CORS разрешает только настроенные origin хоста.
- GET `/healthz`: жизнь процесса; GET `/readyz`: полная локальная готовность опубликованного комплекта.
- GET `/releases/v1/readyz`: 200 для проверенного релиза, 503 для повреждённого marked,
  404 для неизвестного или unmarked. Пустой набор опубликованных релизов даёт module 503.

Пример тела запроса рендеринга, проверенный для обоих тестовых релизов в `service.test.ts`:

```json
{
  "protocolVersion": 1,
  "moduleId": "fixture",
  "releaseId": "v1",
  "instanceId": "slot",
  "props": {},
  "context": {}
}
```

Ответ содержит `{protocolVersion,moduleId,releaseId,html,islands}`.
Каждый дескриптор острова содержит `{id,islandKey,props,policy,identifierPrefix}`.
Ответ формируется через `defineIsland(key, Component, policy)` и
`defineFragment((builder, request) => html)`.
Вызов `builder.island(declaration, props, policy?)` возвращает HTML-обёртку отдельного острова;
`builder.static(reactNode)` рендерит статическое содержимое.
React-компоненты получают `{data: props}`, поэтому данные могут быть любыми JSON-значениями,
включая скалярные значения и `null`. Вложенные объявления островов и вложенные обёртки
отклоняются. Серверный рендеринг синхронный: данные нужно подготовить заранее.
Suspense и потоковый рендеринг не входят в v1.

Props и контекст должны состоять из обычных JSON-значений без циклов; числа должны
быть конечными. Запрещены `undefined`, функции, `BigInt`, даты, геттеры и сеттеры,
разреженные массивы и символы. При сериализации данных экранируются HTML-разделители
и разделители Unicode; для атрибутов применяется отдельное HTML-экранирование.
Не вставляйте пользовательские данные в HTML конкатенацией строк.
HTML рендерера — доверенный код настроенных сервисов, **а не изолированная среда для недоверенных авторов**.
Скрипты внутри фрагментов запрещены. Секреты должны оставаться на сервере;
cookies и заголовок `Authorization` никогда не пересылаются автоматически.

Некорректный запрос получает статус 400, слишком большой запрос — 413,
ошибка рендерера — 500, неизвестный релиз — 404.
Сообщения об ошибках не содержат стек вызовов или входные props.

## Строгие входные контракты

ID с префиксом `islands-`, атрибуты `data-islands-*` и comment markers
`islands-*` зарезервированы framework. Не используйте их во фрагментах и fallback.
Wrapper должен находиться в живом DOM: `template`, `noscript`, `inert` и вложенные
`data-island` недопустимы. Каждый descriptor соответствует ровно одному wrapper.
Коллизия ID между слотами разрешается хостом, а не изменением descriptor.

Массивы props/context имеют стандартный `Array.prototype`, плотные enumerable
индексные data-properties и штатный `length`. Дополнительные, скрытые и symbol
properties, custom prototype, getters/setters и `toJSON` запрещены. Валидатор
не вызывает эти hooks; передавайте простые данные, а не экземпляры классов/Proxy.

## Deployment integrity и probes

`createModuleService` требует для каждого release `releaseDirectory` с
`integrity.json` и `published.json`. Первый содержит schema v1, module/release
identity и path/bytes/SHA-256 каждого output и protocol manifest. Второй связывает
identity с digest inventory. Sidecars не меняют wire protocol и browser URLs.
Все пути относительные, symlinks и не-файлы запрещены; проверяется и точный набор
файлов, и их bytes/digests, включая shared/async chunks. Renderer должен быть callable.
Новая сборка сохраняет browser `assets/manifest.json` и server
`server/emitted-manifest.json`, чтобы потеря output до создания inventory не могла
превратить неполный комплект в успешно аттестованный.

Admission и доступ к manifest/render/assets ожидают проверку. Результат кешируется
на `integrityCheckIntervalMs` (30000 мс), просроченная проверка single-flight с
`integrityTimeoutMs` (10000 мс). Изменение обнаруживается следующим обращением
после истечения интервала; фонового сканирования нет. Read-only mounts остаются
основной защитой от изменения artifacts. На найденный corrupt release возвращается
503; liveness и исправные releases продолжают работать. Для исправления списка
invalid publications требуется явный reload/restart, не автоматический discovery.

Probe-примеры воспроизводятся `node --import tsx --test tests/readiness.test.ts tests/host.test.ts`:

| Сценарий                    | health | module ready | v1 ready | v2 ready |
| --------------------------- | ------ | ------------ | -------- | -------- |
| valid v1, corrupt marked v2 | 200    | 503          | 200      | 503      |
| valid v1, unmarked v2       | 200    | 200          | 200      | 404      |
| нет published releases      | 200    | 503          | 404      | 404      |

Remote outage не влияет на readiness хоста с корректным локальным registry/bootstrap.
