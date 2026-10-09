# frontend-tooling Specification

## Purpose

Предоставить воспроизводимые команды разработки и выпуска фреймворка с двумя примерами, подтверждающими независимость сборок и работу островов.

## Requirements

### Requirement: Reproducible development and production

Проект SHALL предоставлять lockfile, зафиксированный поддерживаемый Node runtime, корневые команды dev/build/start/typecheck/test/test:e2e и отдельные build/start для каждого приложения. Dev SHALL запускать host и два модуля на Windows и Linux и завершать дочерние процессы при остановке.

#### Scenario: Clean checkout

- **WHEN** разработчик выполняет документированные установку и dev в чистой копии
- **THEN** доступны host и оба микрофронтенда, изменение исходников отражается после автоматического обновления страницы

#### Scenario: Production launch

- **WHEN** выполнены build и production start
- **THEN** страница работает из артефактов сборки без dev server, исходников и dev dependencies во время исполнения

### Requirement: Independent release artifacts

Сборка микрофронтенда SHALL создавать согласованные server output, browser entries/chunks, CSS и manifest одного releaseId. Она SHALL завершаться ошибкой при отсутствии заявленных ресурсов.

#### Scenario: Single module release

- **WHEN** разработчик собирает новый релиз каталога
- **THEN** не требуется пересобирать host или корзину, а release manifest ссылается только на существующие ресурсы этого релиза

### Requirement: Demonstration and extension guide

Проект SHALL включать каталог с фильтрацией, корзину с локальным изменением количества, повторные экземпляры и демонстрацию четырёх hydration policies. Документация SHALL описывать добавление третьего модуля через публичные контракты, independent deploy/rollback и границы доверия.

#### Scenario: Demonstration interactions

- **WHEN** пользователь меняет фильтр каталога и количество в гидратированной корзине
- **THEN** оба интерфейса обновляются независимо без перезагрузки страницы

#### Scenario: Third module integration

- **WHEN** разработчик следует инструкции и регистрирует совместимый третий модуль и слот
- **THEN** модуль появляется через конфигурацию без изменения исходников framework runtime
