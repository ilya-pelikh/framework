# microfrontend-releases Specification

## Purpose

Позволить независимо публиковать и откатывать микрофронтенды, сохраняя совместимость протокола и соответствие серверной разметки клиентскому релизу.

## Requirements

### Requirement: Versioned public contract

Каждый модуль SHALL публиковать immutable manifest с версией протокола, moduleId, releaseId, адресом SSR и картой островов с browser entry/CSS URLs. SSR SHALL принимать выбранный релиз, instanceId, props и разрешённый context и возвращать HTML и descriptors островов с теми же идентификаторами модуля/релиза.

#### Scenario: Compatible module

- **WHEN** host подключает модуль с поддерживаемым протоколом и корректным manifest
- **THEN** он использует его SSR endpoint и разрешённые browser assets без импорта исходников модуля

#### Scenario: Contract mismatch

- **WHEN** версия протокола, moduleId, releaseId, island keys или ID wrappers не соответствуют контракту
- **THEN** host отклоняет ответ и показывает fallback слота с диагностикой

### Requirement: Atomic release selection

Система SHALL фиксировать snapshot registry на весь запрос и использовать один релиз модуля для HTML, props, CSS и JavaScript. Валидная атомарная замена registry SHALL применяться к следующим запросам без пересборки/перезапуска host.

#### Scenario: Release switch during request

- **WHEN** registry меняется с v1 на v2 во время формирования страницы v1
- **THEN** текущая страница использует только v1, а следующий запрос использует v2

#### Scenario: Invalid registry update

- **WHEN** новая версия registry не проходит валидацию
- **THEN** host сохраняет последний корректный snapshot и регистрирует ошибку

### Requirement: Immutable assets and rollback

Система SHALL сохранять неизменяемость versioned ресурсов и render endpoints старого релиза до явного удаления оператором. HTML SHALL отдаваться с no-store. Возврат registry на предыдущий релиз SHALL обеспечивать откат без пересборки host.

#### Scenario: Delayed hydration across deployment

- **WHEN** страница v1 открыта до публикации v2 и её отложенный остров активируется после переключения
- **THEN** она загружает ресурсы v1 и успешно гидратируется

#### Scenario: Rollback

- **WHEN** оператор возвращает registry с v2 на v1
- **THEN** новые страницы используют v1 без изменения остальных микрофронтендов

### Requirement: Trusted origins and asset delivery

Система SHALL принимать endpoints только из настроенных разрешённых origins, запрещать redirects при server fetch и предоставлять browser assets с корректными MIME/CORS. URL из пользовательских props SHALL NOT использоваться как адрес загрузки модуля.

#### Scenario: Untrusted endpoint

- **WHEN** manifest или registry ссылается на неразрешённый origin либо endpoint возвращает redirect
- **THEN** загрузка отклоняется без запроса к целевому неразрешённому адресу

#### Scenario: Separate asset origin

- **WHEN** host и ресурсы микрофронтенда находятся на разных origins
- **THEN** browser imports, зависимые chunks и CSS корректно загружаются для разрешённого host
