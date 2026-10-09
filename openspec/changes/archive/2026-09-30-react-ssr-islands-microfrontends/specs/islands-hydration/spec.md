# Spec Delta

## Purpose

Обеспечить выборочную интерактивность серверных фрагментов без гидратации всей страницы и загрузки ненужных клиентских модулей.

## ADDED Requirements

### Requirement: Hydration policies

Система SHALL поддерживать политики `load`, `visible`, `idle`, `never`; JS отложенного острова SHALL загружаться только после его триггера. Статическая оболочка SHALL оставаться негидратируемой.

#### Scenario: Load policy

- **WHEN** bootstrap обнаруживает остров `load`
- **THEN** он запускает загрузку и гидратацию этого острова

#### Scenario: Visible policy

- **WHEN** остров `visible` находится вне viewport, а затем впервые появляется в нём
- **THEN** до появления его JS не запрашивается, после появления он гидратируется; без поддержки наблюдения видимости применяется `load`

#### Scenario: Idle policy

- **WHEN** обнаружен остров `idle`
- **THEN** запуск откладывается до idle callback с timeout 2000 мс или fallback timer 200 мс при отсутствии idle API

#### Scenario: Never policy

- **WHEN** документ содержит остров `never`
- **THEN** его HTML и стили доступны, но его клиентский entry не импортируется и root не создаётся

### Requirement: Deterministic independent roots

Система SHALL использовать одинаковые props, компонент релиза и префикс идентификаторов при SSR и гидратации, уникальные ID экземпляров и независимое состояние. Вложенные острова SHALL отклоняться с диагностикой.

#### Scenario: Repeated component

- **WHEN** страница содержит два экземпляра одного острова
- **THEN** их DOM ID не конфликтуют, начальная гидратация проходит без mismatch, а действие в одном не меняет состояние другого

#### Scenario: Nested declaration

- **WHEN** renderer получает декларацию вложенного острова
- **THEN** фрагмент отклоняется и host использует fallback слота

### Requirement: Safe serializable props

Система SHALL принимать только JSON props и кодировать их так, чтобы значения не могли завершить data script или создать исполняемую разметку.

#### Scenario: Script-like string

- **WHEN** props содержат `</script><script>alert(1)</script>` и Unicode separators
- **THEN** браузер получает исходную строку как данные, не исполняя её

#### Scenario: Unsupported value

- **WHEN** props содержат цикл, функцию, BigInt или undefined
- **THEN** renderer выдаёт контролируемую ошибку слота вместо повреждённого документа

### Requirement: Lifecycle and failure isolation

Система SHALL гидратировать каждый экземпляр не более одного раза, предоставлять dispose и изолировать ошибки импорта/рендера от соседних островов. До гидратации интерактивные controls SHALL быть отключены.

#### Scenario: Duplicate bootstrap and disposal

- **WHEN** bootstrap вызван повторно, затем остров удалён через dispose до завершения import
- **THEN** дублирующий root не создаётся, callbacks отменяются, а поздний import не гидратирует удалённый контейнер

#### Scenario: Import failure

- **WHEN** клиентский entry не загружается
- **THEN** SSR HTML сохраняется, остров отмечается недоступным и ошибка диагностируется без остановки соседей

#### Scenario: Render failure

- **WHEN** гидратированный компонент выбрасывает ошибку рендера
- **THEN** только его root показывает fallback; диагностика включает модуль, релиз и остров
