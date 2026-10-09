# Probes, rollout, drain и retention

Эксплуатационная процедура I7.5. Дополняет `deployment-profile.md`,
`browser-security.md`, `release-migration.md` и `development.md`.
Она не вводит автоматический GC и не разрешает удаление production artifacts.
Runtime не пишет в published releases; cleanup выполняет отдельный оператор.

## Обязательная операционная запись до I8

Владелец среды прилагает к deployment profile утверждённую запись ниже. Текущий
JSON validator deployment profile проверяет network/trust/storage, **не эту
операционную запись**: не добавляйте неизвестные поля в его strict schema.
Отсутствие записи означает отсутствие production qualification.

| Поле                       | Что должен задать владелец среды                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Environment/owner/approver | Та же среда, release operator, on-call и согласующий cleanup                                          |
| Artifact identity          | Commit/build record, module/release IDs, digests, runtime и serving origins                           |
| Probes                     | Интервал, timeout, thresholds, приватный authenticated путь и supervisor/LB action                    |
| Drain                      | Максимальное время исключения из LB, HTTP grace, внешняя force deadline, проверка своих PID           |
| Page lifetime `P`          | Максимальный поддерживаемый возраст документа, включая suspended tabs/BFCache/offline resume          |
| Rollback window `W`        | Минимальное окно возврата после прекращения выдачи релиза; список дополнительных pins                 |
| Propagation `D`            | Верхняя граница завершения in-flight SSR и распространения registry/LB/edge изменений                 |
| Clock margin `S`           | Запас для погрешности часов/учёта; единый источник UTC timestamps                                     |
| Retention `R`              | Не меньше `max(P,W) + D + S`; отсчитывается после последнего deselection, не после build              |
| Ledger                     | История selections/deselections всех consumers, активные и rollback-pinned releases, digest snapshots |
| Cleanup                    | Владелец exclusive maintenance, абсолютные roots/quarantine, backup/restore, audit record             |

Здесь нет выбранных за пользователя target durations или SLO. Значения в тестах
синтетические и не являются рекомендацией production thresholds.

Framework не ограничивает возраст открытой страницы и не отслеживает все её
копии. Если конечный `P` не согласован с продуктовым контрактом (в том числе
восстановление вкладки спустя месяцы), либо невозможно ограничить последнюю
выдачу старого документа, **старые assets сохраняются бессрочно**. Нельзя считать
отсутствие текущих requests или CDN cache hit доказательством отсутствия страниц.
HTML — `no-store`; CDN не должен продлевать выдачу старого HTML скрытым кешем.

## Probes и решения

| Probe                          | Ожидание и решение                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Host `/healthz`                | 200: процесс отвечает; не доказывает исправность registry или remote                                  |
| Host `/readyz`                 | 200: локальный registry/обязательные assets доступны; remote outage сам по себе не убирает host из LB |
| Module `/healthz`              | 200: жив; нельзя заменять этим readiness                                                              |
| Module `/readyz`               | 200: есть valid published release и нет invalid marked; иначе 503, не продвигать instance             |
| Module `/releases/<id>/readyz` | 200: комплект валиден, 503: повреждён, 404: неизвестен/не опубликован                                 |
| Browser/SSR synthetic          | Нужные module/release identities, CSS/entries/chunks, controls и отсутствие unexpected diagnostics    |

В target profile module probes закрыты network ACL и bearer auth. 401/403 —
ошибка probe identity/network policy, не доказательство смерти процесса;
не запускайте бесконечные restart/retry loops. Host `200` при slot fallback
также не считается успешным release synthetic. Секрет не передавайте в URL,
логах или process arguments: используйте private probe agent с secret mount.

Integrity refresh по умолчанию: interval 30 s, deadline 10 s. Просроченная
проверка ожидается single-flight; timeout probe должен учитывать реальный
объём inventory и этот deadline. Выбирайте конечные thresholds по измерениям.
Cached success не доказывает мгновенное обнаружение порчи: проверка происходит
при следующем обращении после истечения interval, а не отдельным фоновым scan.
Probe scheduler определяет дополнительную задержку обнаружения. Read-only
mounts остаются основной защитой immutable bytes.

## Rollout и drain

1. Release operator фиксирует исходный registry, pins, digests и ledger.
   Publisher доставляет новый уникальный ID в отдельный staging; проверяет
   inventory/provenance и публикует атомарно, без изменения старых каталогов.
2. Запускается candidate module instance с новым **и всеми защищёнными старыми**
   релизами. Проверяются module/per-release readiness, manifest/render и assets
   через фактический serving origin. Loader читает список при старте, не наблюдает
   автоматически появление directory. Копирования нового каталога недостаточно.
3. Переключается private/public module serving pool на проверенный instance.
   Все экземпляры, получающие трафик по одному origin, должны обслуживать оба
   поколения URLs. Старые origin/CDN credentials/CORS нельзя отзывать, пока
   остаются поддерживаемые страницы. При одном процессе объявите контролируемое
   maintenance window: встроенный standalone launcher не обещает zero downtime.
4. Registry writer атомарно заменяет **полный** JSON registry рядом с действующим
   файлом в том же filesystem. Не редактирует файл in-place. Сохранённый snapshot
   нужен для rollback. Новые requests используют новый registry; in-flight
   requests могут завершиться со старым. Невалидный registry оставляет last-known-good.
5. Проверяются новые SSR/browser pages и старая открытая страница с ещё не
   загруженным delayed entry/chunk. Host/cart не пересобираются. На каждом host
   consumer подтверждается реальная смена identity, не только readiness 200.
   После подтверждения прекращения выбора старого релиза записывается `T`.
   До подтверждения всех replicas/canaries/LKG consumers история считается неизвестной.
6. При выводе instance сначала исключите его из admission/LB, подтвердите
   propagation, затем отправьте graceful stop. `createHttpServer.stop()` прекращает
   admission и закрывает idle connections; host `onDrain` отменяет upstream работу.
   HTTP grace по умолчанию 10 s, затем sockets принудительно закрываются.
   Это **не** сохранение всех активных requests: host может отменить их сразу.
   Внешний supervisor ограничивает время остановки и завершает только свои PID,
   если JS event loop завис. Общий demo coordinator не подходит для target probes.
7. Для rollback сначала подтвердите readiness и целостность прежнего комплекта,
   затем атомарно восстановите registry pointer. Никаких rebuild или переписывания
   v1 под прежними URLs. Смена обратно на v1 снимает его retirement timestamp;
   для v2 начинается собственный новый lifecycle. При повторном уходе с v1
   его `T` записывается заново. Защищаются страницы обоих поколений.

## Решение о retention

`T` — последний подтверждённый момент прекращения выбора релиза всеми consumers.
`D` покрывает оставшуюся выдачу in-flight HTML и propagation, `S` — погрешность.
Для retirement нужно одновременно:

1. Релиз не выбран ни одним действующим registry, canary, recovery/LKG consumer.
2. Нет rollback pin, incident hold или другого обязательства сохранения.
3. История достоверна, `T` известен и не находится в будущем.
4. Policy заполнена, `R >= max(P,W) + D + S`, текущее время **строго больше** `T + R`.

Incident/recovery hold учитывайте как pin. Если появились сомнения или часы
скачут, решение — KEEP. Возраст build/mtime/последнего asset request, «последние
два релиза» и TTL immutable HTTP cache не заменяют эту проверку. Удалять нужно
целый release, а не только entries или server files: readiness проверяет весь
inventory, rollback использует render, cold imports — shared/async/CSS/media.

`scripts/retention.ts` экспортирует read-only `retirementEligibility(policy,
state, now)`: положительные finite safe-integer durations (D/S могут быть 0),
неполная/некорректная policy/history даёт `eligible:false`. Никаких clocks по
умолчанию, чтения registry, изменения файлов или самостоятельного обнаружения
pins нет. Результат `eligible:true` — только арифметика при достоверных inputs,
**не разрешение на удаление**, не production gate и не готовый GC CLI.

## Manual cleanup: fail closed

1. Получите отдельное approval на конкретные module/release IDs и digests.
   Зафиксируйте policy/clock/ledger, все registry snapshots, pins, expected
   inventory и backup. При неполных данных остановитесь без удаления.
2. Получите exclusive maintenance: остановите registry writers, publishers,
   rollout/rollback automations и изменения pins. Просто сравнить registry один
   раз недостаточно (TOCTOU). Пересчитайте KEEP/candidates под этим исключением.
   Если исключение нельзя гарантировать — cleanup запрещён.
3. Проверьте абсолютные canonical/real paths candidate и quarantine. Они должны
   быть внутри явно выбранного module/maintenance root, не root filesystem,
   не parent, не другой module. Отклоняйте symlink/junction/reparse point на любом
   участке дерева; сверяйте regular-file inventory и trusted digests. Не используйте
   glob, выбор по mtime или shell-команду, собранную из внешнего path.
4. Подготовьте replacement serving instance без кандидата или выведите затронутый
   instance из pool и выполните drain. Не удаляйте каталог из-под живого loader:
   он хранит admitted set; следующая проверка даст aggregate readiness 503.
5. Ещё раз проверьте snapshots/pins/eligibility и перенесите **только approved
   полный release** в отдельный quarantine на том же volume. Перезапустите loader
   со списком оставшихся релизов. При отказе верните неизменённый комплект из
   quarantine, пока writers заморожены; не исправляйте отдельные bytes in-place.
6. Проверьте module ready 200, retired ready 404, все KEEP releases ready 200,
   их прежние hashes, cold old-page imports и rollback synthetic. Только после
   этого разрешайте физическое удаление quarantine по отдельному согласованному
   сроку/approval, с повторной проверкой пути и отсутствия holds.
7. Сохраните audit: actor/approver, policy, timestamps, snapshots/digests,
   удалённые IDs, KEEP reasons, результаты probes/browser/rollback. Не записывайте
   credentials/props. Снимите maintenance lock после подтверждения результата.

Не удаляйте `.reservations`, `.attestations` и журнал использованных IDs:
они запрещают reuse даже после GC. Failed `.staging` разбирается отдельно,
только после подтверждения отсутствия writer; его возраст сам по себе не доказательство.
Для object storage/CDN нужны собственные conditional writes/locks и проверка
всех serving tiers; filesystem rename не является инструкцией удаления CDN prefix.
На Windows выполняйте path checks и операции одним инструментом, например
PowerShell `-LiteralPath`; не передавайте вычисленные paths другому shell.

## Rehearsal и evidence

`node --import tsx --test tests/retention.test.ts tests/retention-rehearsal.e2e.ts`
проверяет границы окон, active/pinned/unknown/overflow, а затем:

- Один раз собирает fixture binary (host и module runtime), host browser assets
  и cart v1; запускает binary в отдельном temp deployment без sources/node_modules.
- Публикует catalog v0/v1, открывает v1 с cold delayed entry **и отдельным async
  chunk**, затем публикует v2, перезагружает module и переключает registry.
- При синтетических часах получает KEEP для v1/v2 и candidate v0. Выполняет
  controlled catalog drain, quarantine/удаление только fixture v0, новый admission
  и probes; host/cart остаются готовы. В реальной среде approvals не автоматические.
- После cleanup впервые загружает оба delayed v1 ресурса по сети, взаимодействует
  с ними и cart, выполняет rollback на v1; hashes всего v1, cart и host outputs
  остаются прежними, happy-path browser ошибок нет.

Отчёт `islands-retention-*/rehearsal.json` содержит schemaVersion, platform/runtime/
Chromium, synthetic policy/clock, decisions, checks и artifact hashes;
`productionQualified:false`. Каталог печатается после успеха.
Windows evidence текущего clean прогона сохранён в `evidence/retention-windows.json`.
Два отрицательных контроля потери entry/chunk остаются в `cold-release.e2e.ts`; hung drain и host
cancellation — в `process-lifecycle.test.ts`. CI/clean verifiers включают новый
rehearsal через `test:hardening`. Полные Windows/WSL verifiers запускайте по очереди.

Rehearsal не доказывает реальные ACL, распределённый lock, сроки удержания,
Nginx/CDN propagation или владельцев среды. Для I8 нужны утверждённая операционная
запись и повторение на настоящей поставке. Числа synthetic policy не переносите
в target profile.
