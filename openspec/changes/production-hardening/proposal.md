# Proposal

## Why

Ревью от 2026-10-01 выявило два дефекта P1 и шесть замечаний P2: незавершённые и конкурентные сборки нарушают гарантии релизов, ошибки HTML/props/cleanup нарушают изоляцию, readiness и release E2E не доказывают готовность полного комплекта. До production необходимо закрыть R1–R8 и реализовать проверяемые эксплуатационные условия из `docs/PRODUCTION_ROADMAP.md`.

## What Changes

- Выполнить восемь последовательных инкрементов I1–I8 в рамках одного change, сохранив трассировку к `docs/TECHNICAL_REVIEW.md` и критерии приёмки каждого этапа.
- Ужесточить JSON/HTML-контракты: namespace ID framework, межслотовые коллизии, live wrappers, безопасный browser payload и массивы без accessors/custom serialization (R2/R5/R6).
- Ввести эксклюзивную reservation release ID, staging, атомарную публикацию и отделение dev outputs; неполная сборка не должна мешать рабочим релизам или восстановлению dev (R1/R3).
- Добавить локальный integrity inventory, проверку всех emitted assets/server exports и готовность отдельного релиза (R4).
- Аттестовать старые релизы только по полному эталонному inventory из доверенного CI/build snapshot; без такого свидетельства отказывать, сохраняя bytes и URL существующих артефактов.
- Сделать dispose идемпотентным, изолировать cleanup failures и освобождать ссылки на DOM/root (R7).
- Доказать cold delayed import старого entry/chunk после переключения, независимые hydration policies и сетевые отказные сценарии в Windows/Linux CI (R8).
- Добавить безопасные диагностические события, метрики, manifest cache/single-flight, пределы concurrency/очередей и конечные startup/shutdown deadlines.
- Подготовить production deployment profile, runtime/security-update policy, retention/runbooks, нагрузочный harness и acceptance gate с измеренными бюджетами и rollout/rollback rehearsal.
- **BREAKING:** deployment layout будет требовать inventory и publication marker для новых production-релизов; старые артефакты допускаются только после явной offline-аттестации без изменения существующих HTML/asset URLs. Строгая валидация отклонит ранее принимавшиеся некорректные фрагменты и массивы; shell обязан включать каждый настроенный слот ровно один раз с сохранением его служебных границ. Wire protocol остаётся v1.

## Capabilities

### New Capabilities

- `production-operations`: диагностика, runtime budgets, manifest cache, управление процессами, deployment/security/retention policy и доказательный production-допуск.

### Modified Capabilities

- `ssr-composition`: целостность итогового документа, локализация структурных отказов, полный local readiness и проверяемая отмена запросов.
- `islands-hydration`: строгие props/payload, live independent roots, идемпотентный и изолированный lifecycle.
- `microfrontend-releases`: атомарная публикация, integrity inventory, сохранение старых assets и первый delayed import после deployment.
- `frontend-tooling`: воспроизводимые инструменты, восстановление dev после build failure, полные артефакты и усиленная автоматическая приёмка.

## Impact

Затрагиваются `packages/{contracts,server,client,rsbuild}`, `scripts/{build,service-entry,start,dev}.ts`, конфигурация host, fixtures/tests, CI, runtime pins и эксплуатационная документация. Потребуются новые deployment-sidecars, параметры лимитов, диагностические hooks и migration tooling; конкретные зависимости выбираются только при необходимости реализации.

Архитектура HTTP SSR-композиции и независимых React roots сохраняется. Недоверенные плагины, SPA/streaming, shared state, бизнес-аутентификация, публикация SDK в npm и provisioning облака не входят в change. Поддержка первого релиза: Windows/Linux и Chromium; другие браузеры и React-пары не объявляются поддержанными без отдельной квалификации.

Целевые domains, инфраструктура, ожидаемая нагрузка и performance budgets ещё не заданы. Их фиксация до измерений и rehearsal на целевой среде являются явными задачами допуска; локальная реализация сама по себе не означает production-ready. Этот change создаёт план; implementation начинается отдельным apply.
