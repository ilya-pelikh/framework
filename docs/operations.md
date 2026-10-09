# Runtime operations: диагностика, cache и budgets

Реализованные механизмы I6. Это не production profile и не подтверждение SLO:
runtime/security/deployment policy I7 и target qualification I8 остаются отдельными
условиями допуска. HTTP/process shutdown описан также в `development.md`.
Probes, rollout/drain, retention и manual cleanup: `rollout-retention.md`.

## События и correlation

`createHost` и `createModuleService` принимают `onDiagnostic(event)` и
`onMetric(metric)`. Событие ошибки содержит `role`, `requestId`, доступные
`moduleId`/`releaseId`/`slot`, `stage`, `category`, `durationMs`. Длительность —
elapsed request/pipeline до события, а не только CPU-время указанной стадии.
Identity берётся из конфигурации/проверенного релиза, не из отклонённого body.
Неидентификаторные значения identity не выводятся. Raw exceptions, messages/stacks,
URL/query, props/context, cookies и credentials в события не включаются.
События frozen; synchronous throw и rejected Promise sink изолируются, sink не
ожидается на критическом пути. Он должен сам ограничивать свою очередь доставки.

| Category     | Значение                                                          |
| ------------ | ----------------------------------------------------------------- |
| `timeout`    | Истёк общий slot deadline или собственный manifest-load deadline  |
| `disconnect` | Клиент отключился либо host drain отменил незавершённую работу    |
| `transport`  | Fetch/socket/запрещённое перенаправление не завершились успешно   |
| `http`       | Upstream вернул неуспешный HTTP status                            |
| `oversized`  | Превышен объявленный или потоковый body limit                     |
| `protocol`   | Неверные JSON, content type или wire schema                       |
| `identity`   | Несогласованные module/release/URL/origin либо нет registry entry |
| `html`       | Нарушение fragment/document/shell contract                        |
| `overload`   | Нет admission/concurrency/body quota или заполнена очередь        |
| `render`     | Renderer бросил исключение                                        |
| `integrity`  | Release не прошёл полную integrity/readiness проверку             |

Стадии: `request`, `registry`, `admission`, `manifest`, `render`, `validation`,
`composition`, `integrity`. Это заменяет прежние агрегированные server-категории
`fragment-failed`, `shell-failed`, `html-invalid`, `disconnected`; обновите filters
сборщика логов. Browser categories и wire protocol v1 не меняются.

Host создаёт новый UUID v4 и возвращает `x-islands-request-id`; внешний client
header не принимается за доверенную correlation. Этот UUID передаётся в каждый
POST render. Service принимает только canonical lowercase UUID v4 с допустимым
variant; иной/повторный/слишком длинный header заменяется новым UUID. Service
возвращает ID в response header. `x-islands-slot` содержит только числовой ordinal
слота (1–3 цифры); host events содержат configured slot name, service — ordinal.
Correlation — не аутентификация и не разрешение доступа к render API.

Разделяемый manifest fetch имеет собственный UUID: одна загрузка обслуживает
несколько consumer requests и не принадлежит первому из них. POST render каждого
consumer по-прежнему сохраняет его host UUID. Cache не хранит request context и
не переносит credentials/props первого клиента второму. Сетевые headers клиента
никогда не копируются целиком.

Инструкции при отказах и роли операторов: [incident-runbooks.md](incident-runbooks.md).

## Метрики

`onMetric` получает `{name:'pipeline',value:1,durationMs,labels}` при успешных и
неуспешных стадиях. `labels` содержит **только** `role`, `stage`, `outcome` (`ok`
или одну category). Request ID, module/release/slot, URL и пользовательские данные
не являются labels. Считайте counter и histogram в sink по этим ограниченным
labels; не добавляйте requestId из соседнего diagnostic event как label.
Несколько этапов одного запроса дают несколько наблюдений: например integrity и
render в service. Метрики не являются числом уникальных HTTP requests.

`admission.snapshot()` возвращает gauges `active`, `queued`, `reservedBytes`,
`modules`; `manifestCache.snapshot()` — `entries`, `bytes`, `pending`. Это immutable
снимки, без списков module IDs/URLs. Снимайте их конечным polling-интервалом в
своём exporter. Встроенный публичный metrics endpoint не открывается.

## Immutable manifest cache

По умолчанию все hosts/fetchers одного экземпляра server package используют один
`defaultManifestCache`:

| Настройка `ManifestCache` | Default           |
| ------------------------- | ----------------- |
| `maxEntries`              | 256               |
| `maxBytes`                | 16777216 (16 MiB) |
| `ttlMs`                   | 300000 (5 минут)  |
| `loadTimeoutMs`           | 1500              |

Ключ включает moduleId, releaseId, полный manifest URL, снимок отсортированного
allowlist и manifest byte limit. Изменение release/URL/allowlist не использует
прежний entry; rollback может использовать ещё валидный immutable v1 entry.
Manifest проходит schema/identity/origin validation. Сохраняются только известные
поля manifest, в том числе entries/CSS; неизвестные `html`/`props` отбрасываются.
Весь сохранённый graph заморожен. Render responses, HTML, props/context не кешируются.

LRU eviction ограничивает count и суммарные UTF-8 bytes ключей + canonical JSON.
Размеры JS objects/parser overhead не равны этому счётчику и не дают hard RSS bound.
Entry больше `maxBytes` используется текущими consumers, но не сохраняется.
TTL проверяется при get/snapshot, просроченные entries никогда не обслуживаются;
idle cache остаётся bounded без фонового таймера. Failed loads не сохраняются.
Не меняйте manifest под старым immutable URL: cache намеренно не опрашивает его
на каждом запросе. Integrity render service остаётся независимой проверкой файлов.

Single-flight объединяет только одинаковые ключи. У каждого consumer свой slot
deadline/AbortSignal; отмена одного не отменяет соседей. После последнего consumer
upstream abort и pending entry удаляются; следующий запрос может начать новую
попытку. Общая загрузка имеет собственный deadline `loadTimeoutMs`, не deadline
первого клиента. Встроенных retries нет.

Для специализированного процесса создайте один `new ManifestCache(limits)` и
передайте его всем hosts через `manifestCache`; для отказных fixtures разрешён
явный `manifestCache: false`. Unit fixture, меняющий ответ по одному URL, должен
отключить cache: это нарушение production immutable contract, не повод выключать
cache во всей системе.

## Admission и byte reservations

`defaultAdmission` разделяется hosts/fetchers одного экземпляра server package:

| Настройка `AdmissionController` | Default           |
| ------------------------------- | ----------------- |
| `maxSlots` на configured route  | 32                |
| `maxActive` pipelines           | 64                |
| `maxPerModule`                  | 8                 |
| `maxQueue`                      | 0                 |
| `maxResponseBytes`              | 67108864 (64 MiB) |

Лимиты проверяются до начала работы; queue допускает 0, остальные значения —
положительные safe integers. Route с превышением maxSlots отвергается при создании
host до fetch. Pipeline резервирует `manifestBytes + renderBytes` (defaults
65536 + 1048576). Поэтому при defaults byte budget может исчерпаться раньше 64
pipelines. Cache hit тоже проходит admission: последующий render требует квоты.
Счётчик активен до освобождения результата, а не только до закрытия upstream socket.

Host удерживает успешные reservations до finish/close своего HTTP response;
error, disconnect, drain и composition failure освобождают их. Low-level
`FragmentFetcher.render()` возвращает `{manifest,response,release}`: потребитель
обязан вызвать `release()` в `finally` **после использования ответа**. Повторный
release безопасен. Не удерживайте результат вне этого lifetime.

При исчерпании квоты и default queue=0 слот немедленно получает overload fallback,
без network request/retry. Если очередь включена, её ёмкость конечна, ожидание
входит в тот же slot deadline. При освобождении квоты выбираются ожидающие с
доступным module/global/body budget: занятый модуль не блокирует доступного соседа.
Завершившаяся/отменённая очередь удаляет abort listener и свою запись.

Для нестандартных limits создайте **один** controller на процесс и передайте его
каждому host/fetcher. Несколько отдельных controllers означают отдельные quota
domains, не суммарный process budget. Аналогично несколько процессов/workers или
независимых копий package требуют внешнего суммарного лимита. Конфигурация авторов
приложения доверенная; это не OS sandbox и не обещание предельного RSS.

## Пример и проверка

```ts
import { AdmissionController, ManifestCache, createHost } from "@islands/server"

const admission = new AdmissionController({ maxActive: 32, maxPerModule: 4 })
const manifestCache = new ManifestCache({ maxEntries: 128 })
const host = createHost({
  registryPath: "/config/registry.json",
  allowedOrigins: ["https://modules.example"],
  bootstrapUrl: "/assets/bootstrap.js",
  routes: {
    "/": [
      {
        name: "main",
        moduleId: "catalog",
        props: {},
        fallback: "<p>Unavailable</p>",
      },
    ],
  },
  admission,
  manifestCache,
  onDiagnostic: (event) => console.error(JSON.stringify(event)),
  onMetric: (metric) => boundedExporter.observe(metric),
})
```

`boundedExporter` здесь — предоставленный приложением ограниченный exporter, не
новый встроенный глобальный объект. Для drain подключите `AbortController.signal`
к `createHost` и `onDrain` у `createHttpServer`, как описано в `development.md`.

`node --import tsx --test tests/diagnostics.test.ts tests/manifest-cache.test.ts tests/admission.test.ts tests/runtime-budgets.test.ts`
проверяет категории/секреты/sinks, concurrent correlation, LRU/TTL/identity,
single-flight cancellation, queue deadline, byte bounds и HTTP burst/disconnect.
Последний файл сохраняет `.cache/budget-smoke-*/evidence.json`. В smoke один занятый
модуль вызывает 20 локальных overload fallback, сосед обслуживается, после
disconnect/error/success gauges возвращаются к нулю. Пример реального локального
прогона: `evidence/runtime-smoke-windows.json`. Он имеет `productionQualified:false`:
это функциональная проверка ограничений, не целевые RPS/soak/RSS/browser budgets I8.
