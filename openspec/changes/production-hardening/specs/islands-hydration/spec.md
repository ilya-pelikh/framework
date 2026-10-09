# Spec Delta

## MODIFIED Requirements

### Requirement: Deterministic independent roots

Система SHALL использовать одинаковые props, компонент релиза и префикс идентификаторов при SSR и гидратации, уникальные ID экземпляров и независимое состояние. Вложенные острова и wrappers вне live DOM SHALL отклоняться с диагностикой; descriptor SHALL соответствовать ровно одному доступному wrapper своего слота.

#### Scenario: Repeated component

- **WHEN** страница содержит два экземпляра одного острова
- **THEN** их DOM ID не конфликтуют, начальная гидратация проходит без mismatch, а действие в одном не меняет состояние другого

#### Scenario: Nested declaration

- **WHEN** renderer получает декларацию вложенного острова
- **THEN** фрагмент отклоняется и host использует fallback слота

#### Scenario: Inert island wrapper

- **WHEN** descriptor ссылается на wrapper внутри template или другого неподдерживаемого inert-контекста
- **THEN** фрагмент отклоняется до отправки документа и получает fallback слота с диагностикой

### Requirement: Safe serializable props

Система SHALL принимать только JSON props и кодировать их так, чтобы значения не могли завершить data script или создать исполняемую разметку. Массивы SHALL быть плотными стандартными массивами с обычными индексными data-properties; accessors, custom serialization, extra properties, symbol keys и нестандартные прототипы SHALL отклоняться без выполнения пользовательских getters или `toJSON`. Обычные plain objects, массивы, null, строки, boolean и конечные числа SHALL сохраняться точно.

#### Scenario: Script-like string

- **WHEN** props содержат `</script><script>alert(1)</script>` и Unicode separators
- **THEN** браузер получает исходную строку как данные, не исполняя её

#### Scenario: Unsupported value

- **WHEN** props содержат цикл, функцию, BigInt или undefined
- **THEN** renderer выдаёт контролируемую ошибку слота вместо повреждённого документа

#### Scenario: Array accessor or custom serialization

- **WHEN** массив содержит getter по индексу, собственный `toJSON`, non-enumerable extra property либо нестандартный прототип
- **THEN** значение отклоняется как некорректные props без вызова getter или custom serialization

#### Scenario: Valid nested JSON

- **WHEN** props состоят из допустимых вложенных plain objects, массивов и скалярных значений
- **THEN** SSR и browser payload получают эквивалентные исходные данные

### Requirement: Lifecycle and failure isolation

Система SHALL гидратировать каждый экземпляр не более одного раза в пределах документа, предоставлять идемпотентный dispose и изолировать ошибки импорта/рендера/cleanup от соседних островов. До гидратации интерактивные controls SHALL быть отключены. Освобождённый экземпляр SHALL NOT удерживать DOM/root/callbacks через active runtime state и SHALL NOT создаваться повторно при повторном bootstrap. Lifecycle-состояние разных документов SHALL быть изолировано.

#### Scenario: Duplicate bootstrap and disposal

- **WHEN** bootstrap вызван повторно, затем остров удалён через dispose до завершения import
- **THEN** дублирующий root не создаётся, callbacks отменяются, а поздний import не гидратирует удалённый контейнер

#### Scenario: Import failure

- **WHEN** клиентский entry не загружается
- **THEN** SSR HTML сохраняется, остров отмечается недоступным и ошибка диагностируется без остановки соседей

#### Scenario: Render failure

- **WHEN** гидратированный компонент выбрасывает ошибку рендера
- **THEN** только его root показывает fallback; диагностика включает модуль, релиз и остров

#### Scenario: Cleanup failure and repeated disposal

- **WHEN** cleanup одного острова выбрасывает исключение во время освобождения набора и dispose вызывается повторно
- **THEN** остальные острова освобождаются, каждый cancel/unmount выполняется не более одного раза и исключение диагностируется без сохранения active references

#### Scenario: Independent document lifecycle

- **WHEN** два документа содержат экземпляры с одинаковыми ID и один документ освобождается
- **THEN** состояние второго документа не блокируется и его roots не размонтируются disposer первого документа

## ADDED Requirements

### Requirement: Validated browser bootstrap input

Система SHALL проверять единственность и тип framework payload, его JSON-структуру и descriptors до создания roots. Ошибки payload, missing container, invalid entry contract и hydrate failure SHALL иметь отдельные безопасные категории диагностики без raw props и секретов. Необработанное исключение входной валидации SHALL NOT прерывать выполнение страницы.

#### Scenario: Malformed document payload

- **WHEN** payload отсутствует для объявленных островов, дублируется, имеет неправильный тип или не является допустимым JSON-массивом
- **THEN** bootstrap сохраняет SSR, не создаёт roots из некорректного payload и выдаёт диагностику

#### Scenario: Invalid descriptor or entry

- **WHEN** явно переданный набор содержит некорректный descriptor, отсутствующий container либо entry без callable hydrate
- **THEN** этот экземпляр не создаёт root, ошибка диагностируется и корректные независимые записи продолжают обработку
