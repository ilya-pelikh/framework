# Ревью архитектуры и упрощения — 2026-10-06

Проверены путь host → fetch → module, состояние readiness/cache/admission,
композиция HTML, browser bootstrap/dispose, сборка релизов и dev/start lifecycle.
Эксплуатационные скрипты рассмотрены как отдельный слой; это не полный аудит
каждой строки qualification/security tooling и не production qualification.

## Результат

Четыре пакета разделяют разные обязанности: wire contracts, серверную композицию,
browser lifecycle и build adapter. Оснований объединять их в один пакет или
переносить код микрофронтендов в host при текущей цели независимых релизов нет.
Польза от упрощения здесь — убрать дублирование состояния и лишнюю работу внутри
существующих границ, сохранив проверяемое поведение.

| Находка                                                                                          | Изменение и эффект                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `service.ts`: релиз и его readiness лежали в двух Map с одинаковыми ключами                      | Одна Map содержит release и checked/valid/pending; исчезла необходимость синхронизации двух коллекций и non-null assertions внутри проверки           |
| `service.ts`: синхронный отказ в async IIFE очищал pending до присваивания результата IIFE       | Проверка стартует через Promise microtask после установки pending. Завершённый отказ больше не блокирует повторную проверку после interval            |
| `client/index.ts`: descriptors из JSON payload проверялись при чтении и повторно перед bootstrap | Document payload валидируется один раз целиком; explicit descriptors по-прежнему проверяются независимо, чтобы ошибка одного не блокировала остальных |
| `rsbuild/index.ts`: для проверки параметров создавалась полная конфигурация с React-плагином     | Выделена внутренняя чистая проверка options; build/manifest используют её без создания неиспользуемой конфигурации                                    |
| `fetch.ts`, `admission.ts`: повторное вычисление stage и лишнее поле waiter                      | Используется уже вычисленный stage; убрана неиспользуемая сохранённая ссылка reject                                                                   |
| `ARCHITECTURE.md`: описание до hardening противоречило реализации                                | Обновлены cache/admission, publication/readiness, document scope, dev build-before-handoff и граница локальных/target инструментов                    |

Дефект readiness воспроизведён до исправления: после первоначального 503 и
исправления конфигурации валидного fixture новый запрос после interval оставался 503. Регрессия `synchronous admission failure expires and retries instead of
retaining a settled flight` теперь проверяет восстановление 200 и aggregate ready.
Это не разрешение менять published bytes: тест исправляет только путь assets в
переданном объекте конфигурации; immutable artifacts остаются прежними.

## Сложность, которую сохраняем

- Fragment validation и document composition решают разные задачи. Первая
  проверяет отдельный фрагмент; вторая — коллизии и перенос DOM parser между
  корректными по отдельности слотами. Удаление одной оставило бы прежние дефекты.
- Admission и manifest cache независимы: кеш сокращает fetch, но не ограничивает
  render/body work. Single-flight с отдельной отменой нужен нескольким consumers.
  Очередь по умолчанию отключена; её поддержка не создаёт очередь без настройки.
- Staging, reservation, inventory и marker дают разные гарантии: незавершённая
  публикация, конкуренция writers, полный набор bytes и допуск к обслуживанию.
  Одна проверка наличия entry не заменяет проверку chunks и renderer.
- Browser active states и seen IDs различаются намеренно: очистка DOM/root
  references не должна позволять повторно создавать освобождённый остров.
- Проверки границ service и host сохраняются даже при использовании defineFragment:
  публичный API разрешает собственный renderer, а host получает HTTP response.
- Qualification/security/retention tools находятся вне request path. Их удаление
  уменьшило бы каталог проекта, но не сложность runtime; локальная работа не
  требует заполнения target profiles.

Новые зависимости, универсальные middleware/validation frameworks и общий
менеджер состояния не вводились. Public API, wire protocol и release layout
сохранены. Ускорение в процентах не измерялось и не заявляется.

## Проверки

Windows, Node 24.21.0: typecheck корня и всех workspaces; 20 целевых серверных
тестов; 18 hardening browser/HTTP scenarios, включая malformed payload, lifecycle,
cross-origin hydration, cold imports, HTTPS и retention/rollback.
Ещё 6 build/manifest/publication tests прошли, включая concurrent publication,
crash injection, missing outputs и отказ невалидного renderer.
Логи: `.cache/simplification-{unit,browser,build}.log`.

Предыдущая полная Windows/Linux матрица и её source hashes относятся к состоянию
до этого ревью. Нового полного Linux-прогона для этих изменений не выполнялось;
исторические evidence не переписываются. Задачи target qualification остаются открытыми.
