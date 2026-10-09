# Production hardening: состояние реализации

Дата: 2026-10-06. Change: `production-hardening`, schema `spec-driven`.
Источник статуса задач: `openspec/changes/production-hardening/tasks.md`.
Это промежуточный отчёт, не production-допуск и не завершение change.

После полной матрицы 2026-10-06 выполнено отдельное ревью и локальное упрощение
ядра: [SIMPLIFICATION_REVIEW.md](SIMPLIFICATION_REVIEW.md). Исправлен retained
readiness Promise при синхронном отказе, объединено состояние релизов, убраны
повторная валидация browser payload и создание build config ради проверки options.
Исторические source hashes ниже относятся к состоянию **до** этих изменений;
проверки текущего ревью перечислены в отдельном отчёте. Прогресс target tasks — 49/53.

## Реализовано и проверено локально

- I1: строгие массивы JSON, reserved HTML namespace, живые wrappers, проверка
  принадлежности узлов слотам, детерминированные ID-конфликты и безопасный shell failure.
- I4: document-scoped lifecycle, идемпотентный изолированный cleanup, защита от
  поздних imports, валидация browser input и безопасная диагностика.
- I2: exclusive reservation, отдельный staging, SHA-256 inventory,
  проверка callable renderer в ограниченном subprocess, atomic rename, strict loader.
  Offline migration по доверенному expected inventory реализована. Crash-injection
  между пятью стадиями, missing entry/CSS/shared/async/server chunk и invalid/hung
  renderer проверены на Windows/Linux с неизменностью v1 после каждого отказа.
  Dev собирается в отдельной generation до handoff, сохраняет last-known-good при
  syntax error и автоматически восстанавливается. Host build не меняет deployment
  registry, а demo явно выбирает отдельный sample. Source-free rehearsal выполняет
  offline attestation, promotion, probes и v1 → v2 → v1 с неизменностью originals.
- I3: полная integrity-проверка перед обслуживанием, per-release/aggregate readiness,
  single-flight перепроверка после истечения интервала, изоляция corrupt release.
- I5: независимо собранный третий модуль, cross-origin React/CSS/MIME/CORS,
  точность script-like/Unicode props и отсутствие happy-path mismatch.
  Добавлены cold v1 entry + отдельный chunk после publication/switch v2, два
  отрицательных контроля, независимые policy entries, наблюдаемое закрытие upstream,
  slow/chunked body и реально слушающий запрещённый redirect target.
  Потеря CSS/shared chunk проверяется через HTTP admission и browser import;
  failed/hung setup освобождает собственные порты и сохраняет безопасные artifacts.
  Happy-path ошибки проверяются также на новых и rollback страницах.
- I6: безопасные categories/stages/duration, UUID correlation, bounded metric labels,
  immutable manifest LRU/TTL и single-flight с независимой отменой consumers,
  global/per-module/queue/body admission budgets, release reservations до finish/close.
  Конечные HTTP limits, общий startup deadline, bounded readiness
  fetch, ранний exit/error, host drain с отменой upstream и graceful/forced cleanup
  owned children. Руководство `operations.md` и безопасный пример
  `evidence/runtime-smoke-windows.json`: burst 20, локальный overload, рабочий сосед,
  нулевые gauges после disconnect/error/success; это не target qualification.
- I7 (7.1–7.6): Node 24.21.0 LTS / npm 11.19.1, типы Node 24.19.1;
  pins/workspaces/lockfile/CI/verifiers/standalone metadata согласованы.
  Официальная support policy, archive checksums и процедура обновления описаны
  в `runtime-policy.md`. `toolchain.test.ts` защищает согласованность pins.
  Install scripts запрещены (esbuild — explicit deny), неизвестные scripts
  останавливают clean install. `security:report` создаёт audit и CycloneDX SBOM
  build/runtime, проверяет полное покрытие lockfile, связывает отчёты с hashes
  artifacts. Любой advisory/сбой scanner/неполный SBOM блокирует gate без waivers.
  Процедура и limitations: `security-updates.md`; три регрессии — `security.test.ts`.
  Добавлены строгий deployment profile/CLI, reference NGINX ACL и permission matrix,
  origin-bound service tokens и private endpoint middleware; CORS не даёт доступа.
  Target profile включает auth и loopback bind standalone binaries. Четыре теста
  `deployment.test.ts` проверяют schema, startup refusal, host/service boundary,
  публичные assets, секреты, duplicate credentials, redirect и соседний origin.
  Документация: `deployment-profile.md`; реальные ACL/mounts/NGINX/TLS не объявлены
  проверенными. Production supervisor запускает отдельные binaries; общий demo
  coordinator не использует authenticated probes этого профиля.
  Target binaries включают CSP без unsafe-inline/eval, nosniff/referrer/HSTS;
  shell CSS вынесен в asset, reload branch удаляется при production build.
  `security-headers.test.ts` проверяет origins/header injection и headers ошибок;
  `https-policy.e2e.ts` запускает три compiled binaries за локальными TLS proxies,
  проверяет authenticated SSR, cross-origin hydration/CSS/CORS и отсутствие dev
  endpoint даже с runtime env reload. Happy path не имеет CSP violations;
  отрицательный контроль блокирует inline script/style. TLS fixture использует
  собственный certificate/SPKI exception, не квалифицирует публичную PKI.
  HTTPS reference templates и ограничения описаны в `browser-security.md`.
  `rollout-retention.md` описывает probes, rollout/drain, операционную запись,
  page lifetime/rollback/propagation/clock margins и manual cleanup с exclusive
  maintenance, quarantine и запретом удаления active/pinned/unknown releases.
  Read-only `scripts/retention.ts` не имеет defaults и ничего не удаляет;
  `retention.test.ts` проверяет границы окон и fail-closed decisions.
  `retention-rehearsal.e2e.ts` выполняет source-free rollout v1→v2, drain/cleanup
  просроченного fixture v0, cold v1 entry/chunk и rollback с неизменными hashes
  host/cart/всего v1. Synthetic clock не квалифицирует реальные сроки retention.
  Target operational record ещё требует владельца среды перед I8 и не проверяется
  существующим network/trust JSON validator.
  `incident-runbooks.md` задаёт роли, эскалацию и восстановление remote outage,
  corrupt registry, missing assets, partial publication и security update.
  Target contacts/SLA/paths/owners остаются обязательными входными данными I8.
  2026-10-05 на Windows/Node 24.21.0 повторены host/registry/readiness/publication
  и security fixtures: все 9 тестов успешны, включая восстановление registry
  существующим и новым reader. Security fixture первоначально получил EPERM
  при npm lockfile preparation в sandbox; отдельный прогон вне sandbox — 3/3.
  Browser missing CSS/shared/blocked shared — 3/3, лог `.cache/runbooks-browser.log`.
  Это локальная проверка процедур, без нового Linux/target или реального audit.
- I8 частично (8.1–8.2): qualification schema/example/CLI без production defaults;
  неполный профиль получает `not-qualified`, корректный — только `profile-valid`.
  `scripts/load-harness.ts` выполняет пять сценариев с bounded open-loop HTTP,
  telemetry и browser adapter; фиксирует budgets, dropped work и failure stages,
  вызывает restore при ошибке, сверяет artifact/deployment identity до нагрузки.
  `npm run test:load` проверяет реальные HTTP/Chromium measurements и отрицательный
  RSS control, missing telemetry, partial enter recovery и deployment hash mismatch.
  Локальный adapter использует общий процесс server/generator и короткие synthetic
  durations, поэтому не квалифицирует production или реальный длительный soak.
  Target adapter/telemetry/fault recovery готовятся владельцем среды перед I8.4.
  Документация: `qualification.md`; пример намеренно содержит незаполненные `null`.
  Windows/Node 24.21.0: typecheck всех workspaces, пять unit tests профиля/harness
  и browser load E2E успешны. Evidence: `.cache/load-harness/smoke-7DzPce/`,
  копии `evidence/load-{profile,smoke,negative}-windows.json`.
  Положительный отчёт — `load-passed`, отрицательный — `not-qualified` по RSS
  каждого из пяти сценариев; оба имеют `productionQualified:false`.
  Smoke добавлен отдельным последовательным шагом CI/Windows/Linux verifiers.
  Полные локальные Windows/Linux проверки выполнены 2026-10-06 (ниже).
  Remote CI не запускался.

## Проверки

### Полный повторный прогон 2026-10-06

Обе платформы проверили одинаковые 152 source/config files: SHA-256 inventory
`a4b6fa1a9e93b0c333f01c7fcd3e869064d99948b50f0bff031b2a8686c764a1`.
Это hash отсортированного JSON массива `{path,sha256}`, не Git commit и не
доказательство build provenance. Commit остаётся `null`; target-профили не заполнены.

- Windows и Ubuntu WSL: полный clean verifier завершился с exit 0 на
  Node 24.21.0/npm 11.19.1/Chromium 153.0.8010.12. Прошли install, typecheck,
  **80 unit/HTTP tests**, build/start/cleanup, **18 hardening browser scenarios**,
  load smoke, independent build/browser, production, source-free deployment/
  rollback, dev failure/recovery и security report (`passed`, без failures).
- Load smoke на обеих ОС прошёл normal/burst/soak/outage/disconnect; отрицательный
  RSS control отклонён во всех пяти сценариях. Это короткие локальные fixtures,
  без target throughput/SLO и production qualification.
- Windows staging: `C:\Users\Ilya\AppData\Local\Temp\islands-verification-f92b2bbf428b4e26a80c1bf7c31abefc\project`.
  Лог: `.cache/windows-2026-10-06-verification.log`.
- Linux staging: `/tmp/islands-verification.EeAj9a/project`.
  Лог: `.cache/linux-2026-10-06-verification.log`.
  Первый успешный Linux-прогон `/tmp/islands-verification.us2Mii` потерял temp tree
  после закрытия WSL; повторный прогон сохраняет evidence в workspace до выхода.
  Не рассчитывайте на дальнейшее существование WSL temp paths.
- Сохранены `docs/evidence/verification-{windows,linux}-2026-10-06.json` с source
  inventory и hashes отчётов; рядом `load-{profile,negative-profile,smoke,negative}`
  обеих ОС с суффиксом даты. Полные audit/SBOM/artifact reports скопированы в
  `.cache/verification-evidence/{windows,linux}-2026-10-06/security/`.
  `.cache` может очищаться; постоянные summary не заменяют полные отчёты.

Код реализации при этом не менялся. I8.3–I8.6 остаются открытыми: положительная
локальная матрица закрывает часть проверок I8.6, но не target qualification.
Все новые evidence records содержат `productionQualified:false`; remote CI не запускался.

### Предыдущие прогоны

На Windows и Ubuntu WSL, Node 24.21.0/npm 11.19.1, Chromium 153:

- `npm run typecheck` — успешно для корня и всех workspaces.
- `npm test` — 75 успешных тестов, включая migration/rollback, lifecycle, I6, pins, security, deployment boundary, headers и retention.
- `npm run test:hardening` — 18 успешных browser/HTTP сценариев, включая CDP
  garbage collection, cold imports и отрицательные контроли.
- Windows: полный clean `scripts/verify-windows.ps1` завершился с exit 0;
  staging `C:\Users\Ilya\AppData\Local\Temp\islands-verification-10f82ad4bbbf4d10b4081aed1cc201aa`.
  Прогон включает independent browser, source-free deploy и dev.
  Source-free deploy: `C:\Users\Ilya\AppData\Local\Temp\islands-deploy-TTie9N`.
  Лог: `.cache/windows-lts-verification.log`. Portable Node проверен по SHA-256;
  системный Node не заменялся.
  На этапе I7.4 параллельный Windows/WSL прогон дал `Missing expected rejection` на
  проверке освобождения localhost-портов после dev smoke; собственно dev recovery
  прошёл. Лог сохранён в `.cache/windows-parallel-verification.log`.
  Повторный полный Windows-прогон без WSL завершился успешно, без изменения теста.
  Эти verifiers используют фиксированные 4100–4103: запускайте их последовательно.
- Ubuntu WSL: полный `scripts/verify-linux.sh` завершился с exit 0 в
  `/tmp/islands-verification.pc7JNh`: clean install, typecheck, unit, build, start,
  hardening, independent build/browser smoke, production, release switch/rollback, dev.
  Source-free deploy: `/tmp/islands-deploy-xkbKNZ`.
  Предыдущий полный I6-прогон на Node 26.10.0: `/tmp/islands-verification.fOI8Tt`,
  Windows `islands-verification-ada4334367bf4c889fda789880c3aea2` (63 unit + 16 browser).
  Safe runtime smoke JSON сохраняет историческую версию Node 26.10.0 своего прогона.
  Пути temp фиксируют место выполнения, но могут очищаться внешним окружением.
- Реальный `security:report` обеих ОС — `passed`, 0 advisories, не production-допуск.
  Windows: `project/.cache/security/1791133755942-87d373d8-b2d7-4827-99f0-f0783188f97a`
  внутри указанного staging; Linux: `project/.cache/security/1791133858306-b4847757-77eb-4d2f-8b79-7e5b2859f33f`.
  Исторический Windows summary I7.2 от 2026-10-03 сохранён в `evidence/dependency-security-windows.json`:
  172 build components, 77 runtime components, hashes 41 artifact files.
  Summary не заменяет полные audit/SBOM файлы и не является build provenance.
- Retention rehearsal: Windows `C:\Users\Ilya\AppData\Local\Temp\islands-retention-cohtze\rehearsal.json`,
  Linux `/tmp/islands-retention-VpIC2b/rehearsal.json`. Windows evidence с hashes
  сохранён в `evidence/retention-windows.json`; `productionQualified:false`.

Сборка fixture выполняется в `.cache` или собственном temp tree, существующие production releases не
переписываются. Rsbuild сообщает прежние предупреждения optional `supports-color`
и динамического Express view dependency; они не объявлены устранёнными.
GitHub Actions обновлён, но remote CI не запускался. Target qualification
не проводилась. Новых measurements
для production budgets нет. Предупреждение npm об unreviewed esbuild устранено
явным deny, а не разрешением неизвестного скрипта. Security evidence не покрывает
Node/OpenSSL/ОС и vendored код вне npm; их review и target gate остаются обязательными.

## Решение и реализация задачи 2.6

Существующие старые outputs содержат browser manifest, но не полный server output
manifest. Перечисление оставшихся файлов и проверка `typeof render === 'function'`
не доказывают наличие lazy server chunks: отсутствующий chunk может потребоваться
только при последующем вызове. Это воспроизводит тест
`legacy callable renderer alone cannot prove completeness of a lazy server graph`
в `tests/integrity.test.ts`.

Новая сборка сохраняет полный server emitted manifest. Для старых релизов нужен
согласованный источник эталонного полного inventory, а не автоматическое доверие
к текущему содержимому потенциально неполной директории.

Согласованное пользователем уточнение: offline attestation получает expected inventory из
доверенного CI/build snapshot, проверяет paths/bytes/digests и callable renderer,
записывает только новые metadata и отказывает при отсутствии такого свидетельства.
Решение внесено в proposal/design/specs/tasks. Реализованы `scripts/attest-release.ts`,
сборка standalone CLI через `npm run build:attestor` и инструкция `release-migration.md`.
Шесть регрессий в `tests/attestation.test.ts` проверяют неизменность originals,
неполный/изменённый комплект, evidence, renderer, конкуренцию и Node-only запуск.
Задача 2.6 выполнена; общий прогресс — 49/53. Требование сохранения bytes и URL остаётся.
Реальные существующие каталоги приложений не аттестовывались: для них нужно получить
подлинный expected inventory и закреплённый digest у publisher.

**Не переключайте действующую поставку на strict loader до завершения миграции.**
Он намеренно не обслуживает прежние unmarked каталоги. Остальные незавершённые
задачи I8.3–I8.6 остаются открытыми; change не архивирован.

Новые инструкции: `test-evidence.md` — сроки, fixtures и безопасные trace/console/
network artifacts; `development.md` — HTTP/lifecycle API; `release-migration.md` —
filesystem/object-storage порядок и Node-only rehearsal. Конечный production gate
по-прежнему требует target profiles, artifact identity, нагрузочные измерения и owners.

Следующий шаг — I8.3: получить от владельца заполненные qualification/deployment
profiles и операционную запись до измерений. В этой копии отсутствуют Git commit
и подтверждённая target environment; local fixture fingerprints не заменяют их.
I8.4–I8.6 требуют доступа к target, согласованных нагрузок/thresholds, recovery
adapter и фактического rehearsal. Эти задачи нельзя закрыть локальными fixtures.
