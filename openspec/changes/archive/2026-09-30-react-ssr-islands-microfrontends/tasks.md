# Tasks

## 1. Workspace и сборочные контракты

- [x] 1.1 Создать npm workspace с четырьмя пакетами и тремя приложениями из design, настроить TypeScript, совместимые зафиксированные версии и engines; проверить чистую установку через npm ci и typecheck.
- [x] 1.2 Создать Rsbuild adapter для Node и browser ESM entries с releaseId, CSS и разделяемыми chunks внутри модуля; проверить минимальный fixture через build, Node SSR и браузерный import с отдельного origin.
- [x] 1.3 Реализовать генерацию immutable manifest из outputs и проверку наличия ресурсов; добавить build tests на корректный релиз и отсутствующий entry/CSS, проверить ненулевой exit code повреждённой сборки.
- [x] 1.4 Документировать outputs, browser entry API и параметры сборки; проверить инструкцию сборкой fixture без участия host и соседнего модуля.

## 2. Протокол и серверный renderer

- [x] 2.1 Реализовать runtime-схемы registry, manifest, render request/response и JSON props; contract tests должны отклонять неверные версии, ID, ключи островов и не-JSON значения.
- [x] 2.2 Реализовать публичные декларации fragment/island и SSR с уникальными instance ID/identifierPrefix; тестами проверить повторные компоненты, запрет вложенных островов и соответствие wrappers/descriptors.
- [x] 2.3 Реализовать безопасную сериализацию payload и атрибутов; тестами проверить script-closing строки, спецсимволы и Unicode separators с точным восстановлением props.
- [x] 2.4 Реализовать Express adapter микрофронтенда с versioned render/manifest endpoints, static assets, immutable headers, MIME/CORS и health/readiness; HTTP tests должны подтвердить контракт, ошибки входных данных и работу двух одновременно доступных релизов.
- [x] 2.5 Документировать HTTP-контракт, доверие к HTML, ограничения JSON и отсутствие автоматической передачи cookies; проверить примеры запросов against fixture service.

## 3. Express host и независимые релизы

- [x] 3.1 Реализовать registry snapshots с атомарным переключением и last-known-good конфигурацией; тестами проверить смену во время запроса, отклонение невалидного обновления и неуспешную readiness при невалидном старте.
- [x] 3.2 Реализовать manifest/render fetch с allowlist origins, запретом redirects, проверкой релиза, timeout и лимитами ответов; HTTP tests должны подтвердить отсутствие запросов на запрещённый origin и fallback при каждом виде нарушения.
- [x] 3.3 Реализовать параллельную композицию слотов, отмену при disconnect, shell/CSS/payload, статусы 200/404/500 и no-store; integration tests должны подтвердить изоляцию отказов и корректный HTML без JavaScript.
- [x] 3.4 Добавить request-scoped context и structured diagnostics; concurrent-request tests должны исключать смешивание props, пересылку credentials и их появление в логах.
- [x] 3.5 Документировать таблицу маршрутов/слотов, registry, настройку лимитов и последовательность release/rollback; проверить команды переключением fixture v1/v2 без перезапуска host.

## 4. Browser islands runtime

- [x] 4.1 Реализовать bootstrap с load/visible/idle/never и fallback для отсутствующих browser APIs; browser tests должны проверить триггеры, отсутствие ранних запросов JS и отсутствие root у shell/never.
- [x] 4.2 Реализовать entry hydrate/dispose, синхронную SSR/client начальную разметку и включение controls после hydration; browser tests должны подтвердить интерактивность, уникальные useId и отсутствие hydration mismatch у повторных экземпляров.
- [x] 4.3 Реализовать import cache, защиту повторного bootstrap и dispose callbacks/roots; тестами проверить один root на экземпляр, cleanup активного root и запрет поздней гидратации после удаления контейнера.
- [x] 4.4 Реализовать диагностику import/mismatch ошибок и локальные error boundaries; browser tests должны подтвердить сохранение SSR при import failure и локальный fallback при render failure без остановки соседей.
- [x] 4.5 Документировать hydration policies, lifecycle, ограничения ранних взаимодействий и отсутствие общего context; проверить примеры API в browser fixture.

## 5. Примеры и рабочий цикл

- [x] 5.1 Реализовать catalog и cart на публичных API с фильтром, количеством, повторными экземплярами и четырьмя policies; browser tests должны подтвердить независимые взаимодействия и стили обоих модулей.
- [x] 5.2 Создать host demo с негидратируемой оболочкой, registry и слотами, включая visible-остров ниже viewport; проверить начальный HTML с отключённым JS и network requests при прокрутке.
- [x] 5.3 Добавить кроссплатформенные dev/build/start/typecheck/test/test:e2e команды, ожидание readiness, reload при server/client изменениях и cleanup процессов; smoke-проверкой подтвердить запуск, обновление и остановку, добавить CI matrix Windows/Linux.
- [x] 5.4 Подготовить deploy-артефакты каждого app и инструкции production start; проверить запуск из отдельного staging каталога с dist/runtime dependencies без исходников и dev server.
- [x] 5.5 Написать руководство добавления третьего микрофронтенда, настройки origins и выпуска/отката; проверить руководство минимальным контрактным fixture без правок framework runtime.

## 6. Сквозная приёмка

- [x] 6.1 Запустить production E2E на отдельных origins: SSR без JS, CSS, hydration policies, повторные экземпляры, ошибки ресурсов и недоступность сервиса; сохранить результаты и подтвердить отсутствие happy-path hydration warnings.
- [x] 6.2 Выполнить release E2E catalog v1 -> v2 -> v1 с неизменным host и cart, включая страницу v1 с отложенной гидратацией после переключения; подтвердить соответствие HTML/client релиза и работу отката.
- [x] 6.3 Выполнить чистые npm ci, typecheck, tests и build, проверить CI matrix и размеры browser entries; зафиксировать результаты приёмки и известные ограничения в документации.
