# Spec Delta

## MODIFIED Requirements

### Requirement: Immutable assets and rollback

Система SHALL сохранять неизменяемость versioned ресурсов и render endpoints старого релиза до явного удаления оператором. HTML SHALL отдаваться с no-store. Возврат registry на предыдущий релиз SHALL обеспечивать откат без пересборки host. Доступность сохранённых ресурсов SHALL обеспечивать первый импорт отложенного entry и его зависимых chunks после переключения на другой релиз, даже если эти файлы ещё не были загружены браузером.

#### Scenario: Delayed hydration across deployment

- **WHEN** страница v1 открыта до публикации v2 и её ранее не загруженный отложенный entry впервые активируется после переключения
- **THEN** браузер получает entry и chunks v1 по сети, успешно гидратирует остров и не подменяет их ресурсами v2

#### Scenario: Rollback

- **WHEN** оператор возвращает registry с v2 на v1
- **THEN** новые страницы используют v1 без изменения остальных микрофронтендов

## ADDED Requirements

### Requirement: Atomic release publication

Система SHALL публиковать релиз только после успешной проверки полного комплекта server/browser/manifest/inventory и SHALL эксклюзивно резервировать release ID до начала записи его артефактов. Незавершённая сборка SHALL NOT быть доступна как опубликованный релиз и SHALL NOT мешать запуску исправных опубликованных релизов. Зарезервированный release ID SHALL NOT переиспользоваться даже после неуспешной попытки.

#### Scenario: Interrupted build or delivery

- **WHEN** процесс завершается до завершения сборки, доставки или публикации новой версии
- **THEN** новый релиз не допускается к обслуживанию, предыдущий опубликованный релиз остаётся неизменным и сервис может быть запущен без ручного удаления staging

#### Scenario: Concurrent duplicate release ID

- **WHEN** две попытки с различными inputs одновременно используют один moduleId/releaseId
- **THEN** только одна получает право сборки/публикации, проигравшая не изменяет ни одного артефакта победившей

#### Scenario: Corrupt published release

- **WHEN** среди опубликованных релизов найден повреждённый комплект
- **THEN** процесс диагностирует повреждённый релиз, не обслуживает его и сохраняет обслуживание исправных релизов; readiness сообщает проблему

### Requirement: Complete deployment integrity inventory

Каждый новый production-релиз SHALL содержать локальный версионированный inventory identity, относительных путей, размеров и контрольных сумм всех исполняемых server/browser outputs, CSS/media и protocol manifest, включая shared/async chunks. Publication metadata SHALL подтверждать identity и digest inventory. Пути SHALL оставаться внутри release root; symlinks и не-файлы SHALL отклоняться. Deployment metadata SHALL NOT менять wire protocol v1 или опубликованные browser URLs.

#### Scenario: Incomplete or mismatched output

- **WHEN** emitted ресурс отсутствует, повреждён, имеет недопустимый путь/тип либо identity sidecars не согласованы
- **THEN** релиз не публикуется и не проходит admission

#### Scenario: Existing release migration

- **WHEN** оператор явно аттестует старый релиз по полному expected inventory из доверенного CI/build snapshot с закреплённым SHA-256
- **THEN** система сверяет identity, полный набор файлов, размеры и digests, проверяет renderer, добавляет только deployment metadata, не изменяет существующие bytes/URLs и допускает старые страницы после миграции

#### Scenario: Missing or mismatched migration evidence

- **WHEN** expected inventory отсутствует, не соответствует закреплённому digest либо текущий комплект не совпадает с ним
- **THEN** offline attestation SHALL завершаться отказом без publication; система SHALL NOT подменять эталон перечнем оставшихся deploy files

#### Scenario: Unattested legacy directory

- **WHEN** production loader обнаруживает каталог без publication metadata
- **THEN** каталог не обслуживается как опубликованный релиз, выдаётся диагностика и исправные аттестованные релизы продолжают работу
