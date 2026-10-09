# Разработка и развёртывание

Используйте зафиксированные версии Node и npm из README.
Команда `npm ci` устанавливает зависимости согласно lockfile.
Команда `npm run dev` выполняет сборку через Rsbuild API, запускает три приложения
Express, ожидает их готовности и отслеживает изменения исходников пакетов и приложений.
При изменениях она собирает новый релиз для разработки и перезагружает подключённые
страницы через локальный поток событий. Полная перезагрузка сбрасывает состояние островов.
Каждая попытка собирается в отдельном `.cache/dev/generation-*` при работающей
last-known-good версии. При compile failure прежние server/client остаются доступны;
следующее исправление автоматически повторяет сборку. Только после successful build
выполняются короткий restart и reload. При ошибке нового запуска восстанавливается
предыдущая generation. Dev не пишет production `apps/*/dist` и registry.
Для остановки нажмите Ctrl+C либо введите `q` и нажмите Enter.
Для автоматических проверок остановки процессов также предусмотрено IPC-сообщение `stop`.
Порты 4100–4103 должны быть свободны.
Релизы для разработки остаются на диске до явного удаления; автоматической очистки нет.

Команда `npm run build` создаёт v1 в чистой копии проекта.
Каталоги неизменяемых релизов никогда не перезаписываются.
Для следующего релиза задайте новый `RELEASE_ID`, например
`$env:RELEASE_ID='v2'` в PowerShell или `export RELEASE_ID=v2` в POSIX-оболочке.
Для сборки только каталога используйте `npm run build --workspace @islands/catalog`;
аналогично можно собрать корзину или хост.
Переменная `PUBLIC_ORIGIN` задаёт origin ресурсов и рендеринга развёрнутого модуля.
По умолчанию каталог и корзина используют localhost:4101 и localhost:4102 соответственно.
Сборка хоста создаёт только `registry.sample.json` для `RELEASE_ID` (по умолчанию v1).
Существующий `registry.json` не изменяется. Нужный deployment registry развёртывайте
отдельно или передавайте через `REGISTRY_PATH`. Для чистого demo запускайте
`npm run start:demo`: флаг `--demo` явно выбирает sample, даже если deployment registry существует.
`ISLANDS_BUILD_ROOT` задаёт отдельный корень output tree для build/start, сохраняя
структуру `apps/<name>/dist` и `dist/start.mjs` внутри него.

Команда `npm start` использует собранный `dist/start.mjs`, управляет тремя
production-приложениями и ожидает их готовности. Во время выполнения ей не нужны
загрузчик TypeScript или инструменты сборки. Для остановки нажмите Ctrl+C
либо введите `q` и нажмите Enter.
Команды `npm run typecheck`, `npm test` и `npm run test:e2e` выполняют соответственно
проверку типов, HTTP-тесты и проверки контрактов, а также браузерные проверки production-сборки.
Установите Chromium командой `npx playwright install chromium`.
Команда `node --import tsx tests/dev-smoke.ts` в копии исходников проверяет
syntax error → сохранение рабочей страницы → исправление → reload и остановку.
`tests/build-registry.test.ts` проверяет byte-for-byte сохранение registry при
повторном host build; `tests/demo-start.test.ts` — чистую сборку и явный demo launch.

Для независимого развёртывания скопируйте **только** `apps/<name>/dist/`
в отдельный каталог. Выполните там `node server.mjs` либо `npm start`
с использованием сгенерированного `package.json`.
Зависимости времени выполнения включены в сборку: установка пакетов, исходники,
символические ссылки workspace, `tsx`, Rsbuild и сервер разработки не нужны.
Встроенные модули Node остаются внешними зависимостями.
Задайте `PORT` равным 4100, 4101 или 4102 для хоста, каталога или корзины соответственно.
Переменная модуля `HOST_ORIGINS` содержит разрешённые origin хоста через запятую.
У хоста `ALLOWED_ORIGINS` задаёт разрешённые origin модулей,
а `REGISTRY_PATH` переопределяет путь к локальному JSON-реестру.
Для каждого отдельно развёрнутого сервиса используйте обычные средства управления процессами.

Сохраняйте каталоги всех релизов, на URL которых ещё могут ссылаться открытые страницы.
Для публикации нового релиза модуля нужно перезапустить его сервис, чтобы загрузить
новый локальный релиз, а затем переключить реестр хоста.
При обновлении каталога хост и корзину не нужно пересобирать или перезапускать.
Атомарное переключение описано в `host.md`.
Полный layout `.reservations`/`.staging`/`releases`, правила same-volume promotion,
offline migration и отдельный порядок для object storage: `release-migration.md`.

Сборка для Node выдаёт предупреждения о неиспользуемом динамическом загрузчике
шаблонизаторов Express и необязательной зависимости `supports-color` пакета `debug`.
Фреймворк не использует эти возможности; запуск из отдельного каталога развёртывания
проверен. В браузерной сборке таких предупреждений нет.

## Ограничения HTTP и lifecycle

`createHttpServer(listener, limits)` из `@islands/server` применяется в bundled
host и module service. Возвращает `{server, stop}`; для запуска вызовите
`server.listen(port)`, для drain — идемпотентный `stop()`.

| Настройка              | По умолчанию |
| ---------------------- | ------------ |
| `requestTimeoutMs`     | 15000        |
| `headersTimeoutMs`     | 5000         |
| `socketTimeoutMs`      | 10000        |
| `keepAliveTimeoutMs`   | 5000         |
| `maxHeaderBytes`       | 16384        |
| `maxRequestsPerSocket` | 1000         |
| `shutdownGraceMs`      | 10000        |

Значения — положительные safe integers; header deadline не больше request deadline.
Проверка поступления headers/body выполняется Node с интервалом не более 1 секунды;
это не deadline выполнения синхронного пользовательского renderer. JSON request
body render service дополнительно ограничен 1 MiB. `server.setTimeout` закрывает
неактивный socket; keepalive и максимальное число запросов также конечны.

При `stop()` admission прекращается, вызывается `onDrain`, закрываются idle
connections; активные HTTP connections получают grace, затем принудительно
закрываются. Host передаёт `AbortController.signal` в `createHost({signal})` и
вызывает `abort()` в `onDrain`: активные upstream fetch отменяются, новые запросы
к drained host получают 503. Hook не должен выполнять блокирующую работу.
Зависший синхронный JS нельзя прервать из того же event loop — внешний orchestrator
завершает принадлежащий ему child после grace.

`startApps(base, stopOnExit, options)` поддерживает `startupTimeoutMs=15000`
(единый для всех приложений), `probeTimeoutMs=1000`, `shutdownGraceMs=10000`,
`shutdownForceMs=2000` и три уникальных `ports` (по умолчанию 4100–4102).
Readiness не читает неограниченное body; ранний exit/error приводит к cleanup.
Максимальное ожидание неуспешного запуска включает startup плюс cleanup grace/force.
Переопределение портов не переписывает manifest/registry URLs — они должны быть
заранее согласованы с конфигурацией. Новые children поддерживают IPC `stop`,
сигналы SIGINT/SIGTERM; после grace отправляется SIGKILL только своим PID.
Dev build ограничен 60 секундами и также завершает свой builder при остановке.

Приёмка cleanup, trace/console/network evidence и clean verifier обеих платформ:
`test-evidence.md`. Реализованные cache/admission/metrics механизмы I6: `operations.md`.
