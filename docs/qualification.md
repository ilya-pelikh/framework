# Qualification profile и допуск

`deployment/qualification.example.json` — незаполненный target-шаблон.
Все `null` заполняются владельцем среды до измерений. В нём намеренно нет
придуманных production RPS, SLO, owners или commit. JSON Schema:
`deployment/qualification.schema.json`; семантический validator дополнительно
проверяет origins, уникальные identities, retention и непротиворечивость порогов.

```text
npm run qualification:validate -- deployment/qualification.example.json
```

Для шаблона ожидается exit 1, `status:not-qualified` и пути отсутствующих полей.
Заполненный файл даёт `profile-valid`, но всегда `productionQualified:false`:
проверка структуры не удостоверяет подпись владельца, provenance или результаты.
Валидация не обращается к сети и не запускает нагрузку.

До запуска фиксируются UTC `approval.frozenAt`, согласующий и ссылка на approval,
commit и SHA-256 каждого квалифицируемого artifact, SHA-256 точного deployment
profile. Версии изменённого файла требуют нового approval и прогона. У этой
рабочей копии нет Git metadata: нельзя подставлять выдуманный commit.

| Раздел            | Смысл                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| environment       | Название среды, HTTPS host origin, asset origins, hash deployment profile                                                      |
| identity          | Реальный commit и именованный перечень artifact SHA-256                                                                        |
| owners / approval | Environment/release/security/on-call и запись согласования                                                                     |
| operations        | Заполненная запись runbooks; page lifetime/rollback/retention и margins в ms                                                   |
| workload          | Для каждого normal/burst/soak/outage/disconnect: RPS, concurrency, duration, deadline, время disconnect и взвешенный route mix |
| routes            | Path без credentials/query, относительный weight, фактические slots и размер JSON props в bytes для соответствующего сценария  |
| devices           | Viewport, scale, mobile и CPU slowdown; эмуляция Chromium не доказывает поведение реального устройства                         |
| networks          | Latency ms, download/upload bytes/s, применяемые отдельно к каждому устройству                                                 |
| thresholds        | Отдельные maximum budgets для каждого сценария, включая ожидаемые outage/disconnect отказы                                     |

Budgets: p95/p99 HTTP latency в ms, RSS в bytes, p99 event-loop delay в ms,
connections, fallback/error доли 0–1, browser transfer bytes, hydration ms, CLS.
`latencyP95Ms <= latencyP99Ms`; retention не меньше
`max(pageLifetimeMs, rollbackWindowMs) + propagationMs + clockMarginMs`.
Route payload не содержит пользовательские данные: target adapter должен
предоставить заранее согласованный synthetic workload и подтвердить его mix.

`purpose:local-smoke` позволяет локальные HTTP origins. Такое evidence никогда
не выдаёт production-допуск, даже при всех зелёных budgets. Target qualification
также требует отдельного evidence для R1–R8, ACL/TLS/security, cold old-page imports,
keyboard/labels/disabled/error UX и rollout/rollback/interrupted publication.
Неизвестные или непроверенные условия сохраняются как `not-qualified`.

## Нагрузочный harness

`npm run test:load` собирает отдельные busy/neighbor releases и browser runtime,
запускает HTTP/Chromium normal/burst/soak/outage/disconnect, затем повторяет их с
заведомо нарушенным RSS budget (1 byte). Команда успешна только если первый прогон
проходит, а второй отклоняется именно по RSS каждого сценария. Ошибки browser,
отсутствие telemetry и незапущенная требуемая нагрузка тоже блокируют результат.
Проверяется restore даже после частичного отказа enter и отсутствие raw ошибок.

`.cache/load-harness/smoke-*/` содержит профили и положительный/отрицательный JSON
reports. CI обеих ОС сохраняет их на 30 дней, в том числе при отказе. `profileSha256`
считается по UTF-8 `JSON.stringify(profile)` без форматирования; artifact hashes
относятся к исходным bytes. Negative control имеет собственный hash профиля.
Локальный `identity.commit` явно является SHA-256 исходника fixture, а поле
deployment profile содержит hash synthetic registry; это не Git commit и не
настоящий deployment profile. Подставлять эти identities в target запрещено.

Smoke durations 400/800 ms и его широкие budgets проверяют сам harness; 800 ms
не является эксплуатационным soak. RSS/event loop измеряются у общего процесса
fixture и load generator; connections — сумма sockets module servers. Эти
измерения нельзя экстраполировать на изолированный production server.
Browser runtime и полные release inventories связаны с отчётом через hashes.
Target server binaries требуют своего inventory/provenance и отдельного telemetry.

## Target adapter

`runLoadHarness(profile, adapter)` из `scripts/load-harness.ts` принимает
`LoadAdapter`. Нагрузка выполняется только после `begin`, который должен проверить
реальные commit/artifacts, deployment profile и synthetic routes/slot/props mix,
а также вернуть server runtime/platform versions. Профиль передаётся копией;
adapter не должен менять согласованный workload. В проекте поставляется только
localhost adapter; универсального публичного fault/metrics endpoint нет.

| Метод    | Обязательство адаптера целевой среды                                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| begin    | Сверить фактические artifact identities и deployment-profile digest, route/slot/payload mix; отказать при несовпадении, вернуть версии серверов |
| enter    | Включить согласованный сценарий, для outage изолировать только тестируемый remote, для disconnect обеспечить незавершённый upstream             |
| restore  | Идемпотентно восстановить среду и проверить recovery; вызывается также после частичного enter failure                                           |
| sample   | Получить RSS, p99 event-loop ms и connections из серверной telemetry, не из процесса load generator                                             |
| classify | По ограниченному HTTP response определить fallback/error без сохранения HTML или пользовательских данных                                        |
| browser  | Применить выбранные device/network, проверить hydration/соседа и вернуть transfer/hydration/CLS, error count и Chromium version                 |

Hooks должны учитывать AbortSignal и завершать собственные connections/resources
при отмене: harness даёт им 30 s, telemetry — 5 s. Promise timeout не способен
остановить произвольный код, игнорирующий signal. Для target faults необходимы
внешний TTL/автовосстановление и supervisor: force kill самого harness не выполняет
`finally`. Secrets получает private adapter из secret mount, не из профиля/CLI/URL.
Restore failure означает `not-qualified`; ручное recovery выполняется по runbook.
Adapter и fault permissions готовятся владельцем среды до запуска I8.4.

Профиль frozenAt должен предшествовать измерениям. Нагрузочный генератор:

- Планирует open-loop RPS с конечным concurrency и без очереди/retries. Если не
  может выпустить запланированный request, фиксирует `dropped` и проваливает
  `load-generator-capacity`; не снижает заданный RPS молча.
- Запрашивает взвешенный route mix GET, запрещает redirects, ограничивает response
  2 MiB и deadline профиля. Измеряет полную HTTP latency до чтения body/отмены
  (включая network; это не чистое CPU time). P95/P99 включают ошибки/abort и
  используют bounded histogram с верхней границей 1 ms buckets.
- Fallback/error rates делятся на число started requests; ожидаемые disconnect
  считаются отдельно. Outage без наблюдаемого fallback и disconnect без реальной
  отмены не считаются выполненными. Target adapter дополнительно подтверждает
  освобождение upstream resources; localhost fixture проверяет закрытие response.
- Снимает telemetry перед, во время (50 ms interval) и после HTTP нагрузки:
  RSS/connections max и максимальный наблюдаемый p99 event-loop. Частота sample
  не гарантирует обнаружение более коротких пиков. Adapter задаёт согласованный
  scope aggregate/per-process и window server histogram в своей evidence записи.
- Затем для каждого route/device/network запускает browser measurement при ещё
  включённом сценарии. Это отдельная browser phase, не конкурентная browser
  нагрузка в течение server soak. Browser budgets берутся по максимуму комбинаций.
  Fixture использует новый context без cache/service workers, CDP network/CPU,
  фактические network encoded bytes, время navigation→enabled controls и CLS
  session windows; наблюдение заканчивается после interaction и 100 ms. Это не
  field CLS или lifetime измерение длительной страницы.

Явные пределы одной конфигурации harness: concurrency 4096, RPS 10000, scenario
duration 24 h, request deadline 120 s, 10 миллионов запросов/scenario, сумма route
weights 1 миллион и 128 browser combinations/scenario. Превышение даёт отказ,
не автоматическое ограничение workload. Более крупный профиль требует отдельного
согласованного инструмента/изменения harness.

`load-passed` означает только успешные нагрузочные budgets и измерения данного
профиля. `productionQualified` всегда false: отчёт явно перечисляет ещё требуемые
security boundary, cold import, accessibility, rollout/recovery, R1–R8 и owner
signoff. Финальный допуск I8.6 должен сопоставить эти свидетельства с теми же
artifact/profile hashes. Обобщённый статус нельзя превратить в допуск переименованием.
