# Ограниченная приёмка и failure evidence

`npm test` ограничивает node:test-файлы 120 секундами; `test:hardening` — 60,
с более короткими deadlines отдельных сценариев. Standalone build/start/browser/
release/dev smoke также обёрнуты в node:test с 120 секундами. Проверки должны
запускаться без посторонних приложений на фиксированных demo-портах 4100–4103,
4310–4311; случайные порты используются остальными HTTP/browser fixtures.

## Fixtures и cleanup

- `tests/helpers/runtime-browser.ts`: runtime build в собственном subprocess
  (15 секунд), затем HTTP server и browser session. Ошибка setup закрывает server;
  cleanup зарегистрирован и как `TestContext.after`, и в `finally`, идемпотентно.
- `tests/helpers/browser-session.ts`: запуск Chromium через owned BrowserServer,
  общий launch/connect/setup deadline 10 секунд, context/action 5, navigation 10.
  Закрытие browser: 3 секунды grace, затем kill с 2-секундным ожиданием. Cleanup
  выполняется и при ошибке создания context/пользовательского setup, не только launch.
- `tests/helpers/http-server.ts`: закрывает активные HTTP connections своего server.
- `scripts/process-lifecycle.ts`: завершает только переданный owned child, не ищет
  процессы по имени/порту; graceful/forced сроки конечны. Launcher прекращает
  ожидание при раннем exit/error и не создаёт бесконечный readiness fetch.
- `tests/retention-rehearsal.e2e.ts`: отдельный source-free temp deployment,
  compiled fixture binary с IPC deadline 10 секунд и owned-child stop/force.
  Проверяет cleanup только просроченного fixture release, cold v1 и rollback;
  `rehearsal.json` содержит hashes и synthetic policy, не target qualification.
  Procedure/границы: `rollout-retention.md`.

`tests/fixture-cleanup.e2e.ts` намеренно ломает browser executable, бросает ошибку
после создания страницы и подвешивает setup. После каждого случая собственный порт
можно занять снова, посторонний HTTP server остаётся доступен. `process-lifecycle.test.ts`
проверяет hung readiness/child, ранний exit, long request и отмену upstream при drain.

## Безопасные артефакты

Browser fixtures сохраняют `.cache/test-artifacts/run-*/` при cleanup, включая
неуспешный setup. CI загружает только это дерево при failure, срок хранения 7 дней.
Не загружайте весь `.cache`: там есть source copies и build outputs.

- `trace.json`: структурный timeline в Chrome Trace Event JSON; стадии setup/build/
  listen/launch/context/cleanup и browser/network events с относительными timestamps.
- `console.json`: тип сообщения и ordinal страницы, **без текста/аргументов/stack**.
- `network.json`: ordinal страницы/request, resource type, HTTP status и failure,
  **без URL, query, headers, credentials, request/response body**.

На каждый stream максимум 4096 записей; `dropped` показывает потери сверх лимита.
IDs локальны одному fixture; содержимое DOM/props, screenshots, evaluate arguments
и sources не записываются. Это не raw Playwright `trace.zip`: полный trace способен
содержать секреты в DOM/network/evaluate и намеренно не включён. JSON timeline можно
открыть в совместимом Trace Event viewer; он даёт порядок/длительность событий, но
не позволяет восстановить содержимое запросов. Для ошибки до browser launch streams
console/network пусты, доступные setup stages всё равно сохраняются.

Отказной тест передаёт один secret marker через query, Authorization, console и
exception и проверяет его отсутствие во всех трёх artifacts. Проверка не зависит
от regex-замены известных секретов: потенциально чувствительные поля вообще не
попадают в writer.

## Ошибки успешного сценария

`browserSession.assertHealthy(page)` отклоняет console error/warning и pageerror.
Проверяйте его после реального interaction/React commit, а не только наличия SSR
или `data-hydrated`. Он применяется к новым и rollback страницам release smoke,
policy API fallbacks, independent build, production happy paths и dev recovery.
Отрицательные сценарии import/render отдельно проверяют ожидаемую локальную
категорию/SSR/интерактивного соседа; их ожидаемые network failures не разрешают
игнорировать ошибки других happy-path страниц.

## Воспроизведение всей матрицы

Windows: `powershell.exe -NoProfile -File scripts/verify-windows.ps1`.
Ubuntu: `sh scripts/verify-linux.sh` из корня проекта; для установки системных
browser dependencies используйте `INSTALL_BROWSER_DEPS=1` с нужными правами.

Оба verifier создают **новую** isolated copy без node_modules/dist/.cache,
выполняют clean install, typecheck, unit, build, compiled start, Chromium,
hardening, independent build/browser, production, release switch/rollback и dev.
Windows использует установленную pinned Node/npm пару; Linux скачивает pinned Node.
Verifier не удаляет staging/evidence, но OS temp (особенно WSL) может быть очищен
внешним окружением. Скопируйте нужные безопасные artifacts в постоянное хранилище
до его остановки/очистки. Выведенный путь и exit code фиксируют локальный прогон,
но не гарантируют последующую доступность temp и не означают запуск GitHub Actions.
