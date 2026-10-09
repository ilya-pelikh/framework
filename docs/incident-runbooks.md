# Инциденты и восстановление

Инструкции I7.6 для trusted deployments. Порядок rollout/drain и сохранения
старых ресурсов задан в [rollout-retention.md](rollout-retention.md), права и
service authentication — в [deployment-profile.md](deployment-profile.md).
Локальные fixtures ниже не выполняют операции над действующей поставкой.

## Ответственные и эскалация

До I8 владелец среды заполняет отдельную операционную запись. Не добавляйте её
поля в strict JSON deployment profile: его validator не проверяет эту запись.

| Роль                               | Ответственность                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| Incident commander / on-call       | Оценка влияния, остановка promotion/cleanup, журнал действий, координация восстановления      |
| Module owner                       | Диагностика render/fragment, проверка корректного релиза и соседей                            |
| Registry writer / release operator | Атомарные переключения полного registry, snapshots, rollback и ledger                         |
| Publisher                          | Доверенные build snapshots/inventory, новые уникальные IDs и provenance                       |
| Platform / CDN owner               | Private connectivity, TLS/auth, serving pools, immutable storage и edge delivery              |
| Security owner                     | Подозрение на изменение artifacts/credentials, advisories, containment и проверка исправления |
| Environment owner                  | Целевые SLO, сроки/контакты эскалации, согласование восстановления и итоговый incident review |

Обязательные target-поля: имена и резервные ответственные каждой роли, контакты
и канал инцидента, severity/влияние, время подтверждения и эскалации, адреса probes
и serving origins, ссылки на secret mounts (без значений), supervisor/LB commands,
registry paths и writer lock, trusted snapshot/evidence storage, artifact digests,
retention/holds, сроки проверки после восстановления и согласующий закрытие.
Отсутствующие значения остаются незаполненными; production qualification запрещена.

При потере соседних модулей, повторном отказе восстановления или истечении
согласованного срока on-call привлекает environment owner и platform owner.
Неожиданное изменение bytes, origin или прав немедленно эскалируется security owner.
Оператор сохраняет UTC timeline, identities/digests до и после, безопасные category/
stage/request IDs, статусы probes и результаты browser synthetic. Props, токены,
query strings и raw exceptions в общий журнал не включаются.

## Remote outage

1. On-call подтверждает влияние по fallback/timeout/transport/http-status событиям
   и synthetic страницы. HTTP 200 страницы не означает, что все слоты работают.
   Host ready 200 при remote outage ожидаем: не перезапускайте здоровые hosts.
2. Module/platform owners проверяют private module health, aggregate и выбранный
   release readiness через штатный authenticated probe agent. 401/403 проверяют
   как auth/ACL failure; 404 release — как ошибку выбранного ID; 503 — как проблему
   integrity/набора релизов. Проверяют DNS/TLS/connectivity и admission metrics.
3. Останавливают promotion затронутого модуля. Сохраняют bounded fallback без
   увеличения deadlines/очереди и автоматической лавины retries. Platform owner
   восстанавливает approved connectivity или serving instance. При дефекте новой
   версии release operator сначала проверяет прежний комплект, затем выполняет
   атомарный registry rollback по rollout-инструкции.
4. Проверяют успешный SSR выбранной identity, интерактивность модуля и соседа,
   отсутствие неожиданных diagnostics, спад fallback и возврат admission gauges.
   Commander закрывает инцидент после целевого observation window.

## Corrupt registry

1. Registry writer блокирует конкурирующие изменения и сохраняет повреждённый
   файл в защищённое evidence storage. Сверяет origin/release paths с approved
   конфигурацией и доверенным snapshot; не публикует содержимое с секретами.
2. Живой host сохраняет последний корректный snapshot в памяти. Разные replicas
   могут иметь разные LKG; новый процесс без корректного файла ready 503.
   Не выполняйте массовый restart до восстановления файла. Readiness 200
   работающего процесса не доказывает корректность файла на диске.
3. Проверяют readiness прежних releases и доступность их assets. Подготавливают
   полный approved JSON рядом с registry и атомарно заменяют файл на том же
   filesystem одним writer. Не редактируют действующий JSON частями.
4. Проверяют новый snapshot и реальные SSR identities на каждой replica, затем
   readiness нового candidate host. Сохраняют hashes восстановленного registry
   и ledger. При неизвестном происхождении повреждения привлекают security owner.

## Missing assets или integrity mismatch

1. Module/CDN owners различают origin integrity failure и edge/browser failure:
   проверяют release readiness и точный versioned URL entry/CSS/shared/async chunk
   через serving origin. Проверяют status, MIME, CORS/CSP и digest, не только cache hit.
   У module integrity есть bounded detection window; ready 200 не проверяет CDN.
2. Останавливают promotion и cleanup, ставят incident hold на связанные релизы.
   При повреждении origin готовят отдельный replacement instance из доверенного
   полного snapshot с прежними bytes/URLs и всеми protected releases. Проверяют
   inventory до admission; не редактируют живой release и не пересчитывают его
   inventory поверх повреждённых bytes. Если эталона нет — эскалация publisher.
3. При исправном origin platform owner восстанавливает edge routing/headers и
   доставку именно исходных bytes. Новый код публикуется только с новым ID.
   Registry rollback помогает новым страницам, но сам по себе не чинит старые
   документы: их старые URL также должны быть восстановлены.
4. Проверяют aggregate/per-release readiness, origin и edge digests, cold import
   старой страницы с отдельным chunk, CSS и controls соседей. SSR при import failure
   должен сохраняться с локальным unavailable. Документируют длительность нарушения
   retention; снятие hold выполняют отдельно после восстановления.

## Partial publication

1. Publisher останавливает продвижение candidate, сверяет transaction/staging,
   reservation и наличие publication metadata. Незавершённый staging не является
   релизом; нельзя вручную дописать marker, чтобы обойти проверку комплекта.
2. Проверяют неизменность inventory рабочего релиза и его ready 200. Незавершённая
   попытка остаётся зарезервированной: retry использует новый release ID.
   Сохраняют staging как evidence; не удаляют reservation tombstones.
3. Повреждённый marked candidate изолируют заменой serving instance после drain
   по rollout-инструкции. Valid соседи должны оставаться доступны, но aggregate
   readiness 503 нельзя игнорировать. Quarantine требует проверки paths/holds и
   полномочий оператора; возраст staging не доказывает отсутствие writer.
4. Publisher собирает/доставляет новый полный комплект, проверяет integrity и
   callable renderer, публикует atomic rename на одном volume. Для object storage
   применяет отдельный conditional publication/commit-pointer процесс из
   [release-migration.md](release-migration.md), проверяя все serving tiers.
5. Candidate loader запускается с полным protected набором; после probes и
   browser synthetic registry writer переключает pointer. Проверяют cold old-page
   import и rollback без rebuild host/соседей.

## Security update

1. Security owner фиксирует advisory, affected versions/artifact digests,
   reachability и containment; при подозрении на компрометацию подключает platform
   owner для изоляции publisher/credential по target incident policy.
2. Promotion блокируется при advisory, недоступном scanner или неполном SBOM.
   Выполняют [security-updates.md](security-updates.md): exact pins/lockfile,
   review install scripts, clean Windows/Linux/Chromium и standalone acceptance,
   новые audit/SBOM и отдельный review Node/OpenSSL/ОС.
3. Публикуют новый immutable ID и сохраняют evidence с digests; проходят target
   qualification и rollout/rollback. Уязвимый rollback candidate не считается
   допустимым автоматически. Если сохранение старых assets конфликтует с containment,
   security/environment owners явно фиксируют решение, влияние на старые страницы
   и нарушение retention; не объявляют такой rehearsal успешным.
4. Закрывают advisory только после проверки исправления на конкретном комплекте.
   Зелёный локальный synthetic audit не заменяет реальный scanner и target gate.

## Локальное воспроизведение

Из корня проекта с закреплёнными Node/npm и установленным Chromium:

```text
node --import tsx --test --test-timeout=120000 tests/host.test.ts tests/registry.test.ts tests/readiness.test.ts tests/publication-faults.test.ts tests/security.test.ts
node --import tsx --test --test-timeout=60000 tests/asset-failure.e2e.ts
```

| Инцидент            | Что доказывает fixture                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Remote outage       | Host timeout/status fallback, bounded fetch, host ready и изоляция слота (`host.test.ts`)                                                                                |
| Corrupt registry    | Invalid initial state, LKG, atomic restoration и новый reader (`registry.test.ts`)                                                                                       |
| Missing assets      | Missing shared/changed async дают 503, valid сосед работает (`readiness.test.ts`); CSS/shared/import failure сохраняют работающий browser-сосед (`asset-failure.e2e.ts`) |
| Partial publication | Crash на пяти стадиях и missing outputs не публикуются, v1 hashes/ready сохраняются, reuse ID запрещён (`publication-faults.test.ts`)                                    |
| Security update     | Findings/unavailable/incomplete SBOM блокируют gate; unreviewed script запрещён, explicit deny не исполняется (`security.test.ts`)                                       |

Fixtures используют отдельные `.cache` trees, localhost и fault injection.
Security fixture подставляет audit response и не подтверждает отсутствие текущих
уязвимостей. Rehearsal rollout/retention отдельно описан в `rollout-retention.md`.
Target ACL/CDN, реальные контакты, SLA и recovery timings остаются предметом I8.
