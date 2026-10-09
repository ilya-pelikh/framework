# Выбор runtime

## Решение — 2026-10-06

Проект не закрепляет конкретную версию Node.js. Локальная разработка и оба
verification-скрипта используют `node` из PATH; CI устанавливает актуальную
LTS-версию через `actions/setup-node` (`lts/*`). Файл `.node-version` удалён,
ограничения Node в workspace-манифестах, lockfile и standalone deploy metadata сняты.
Требования зависимостей к Node по-прежнему проверяет `engine-strict`.

Ранее Node 24.21.0 был закреплён решением I7.1 для воспроизводимых проверок
Windows/Linux на выбранном LTS-окружении. Это закрепление окружения отменено;
версии в старых отчётах и evidence описывают фактически выполненные прогоны.

Для проверок сохраняется npm **11.19.1**. `@types/node` **24.19.1** — версия
зависимости с типами, а не ограничение исполняемого Node.js. Успешный typecheck
не заменяет runtime-проверки на выбранной версии.

## Воспроизведение

Установите Node.js в PATH и выполните
`npm install --global npm@11.19.1 --ignore-scripts`.

- Windows: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows.ps1`.
- Linux: `sh scripts/verify-linux.sh`.
- Для установки системных библиотек Chromium в Linux:
  `INSTALL_BROWSER_DEPS=1 sh scripts/verify-linux.sh` с необходимыми правами.

Скрипты создают отдельную копию проекта и используют установленный runtime.
Они выводят версию Node; сохраняйте её вместе с результатами проверок.
При смене runtime повторяйте install/typecheck/unit/build/start/browser/release/dev
проверки на целевых платформах. Существующие immutable releases и их inventory
не переписываются; для новых сборок используйте новые release IDs или отдельные
build roots. Production qualification остаётся привязанной к конкретным artifact digests.
