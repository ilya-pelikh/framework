# Offline-аттестация старых релизов

Используйте перед переходом существующей поставки на strict loader. Мигратор
не обновляет приложения или registry и не генерирует «эталон» из проверяемой копии.
Все versioned URL, manifest, server и browser bytes остаются прежними.

## Доверенное свидетельство

Получите полный inventory исходного **успешного** CI/build snapshot из защищённого
архива publisher. Сверьте его SHA-256 с digest, закреплённым в доверенном release
record, а не вычисленным только из произвольного файла рядом с deployment.
SHA-256 подтверждает равенство bytes, но не авторство: права CI/archive и approval
оператора остаются обязательными. Проверяемый код renderer является доверенным;
subprocess с timeout не является sandbox.

Формат expected inventory:

```json
{
  "schemaVersion": 1,
  "moduleId": "catalog",
  "releaseId": "v1",
  "files": [
    {
      "path": "server/server.mjs",
      "bytes": 1234,
      "sha256": "<64 lowercase hex characters>"
    }
  ]
}
```

Пример показывает структуру, **не валидный полный inventory**. Перечислите каждый
исходный файл, включая protocol `manifest.json`, browser `assets/manifest.json`,
server/browser shared и lazy chunks, CSS/media. Пути относительные, через `/`;
directories, symlinks, traversal и совпадения путей без учёта регистра запрещены.
`server/emitted-manifest.json` у старого snapshot может отсутствовать.
`integrity.json`, `published.json`, `attestation.json` в исходный набор не входят.
Без сохранённого эталона из доверенной сборки миграция **не разрешается**:
получите свидетельство у publisher, не создавайте его из оставшихся deploy files.

## Запуск

1. На build machine выполните `npm run build:attestor`. Доставьте полученный
   `dist/attest-release.mjs` через доверенный канал вместе с проверенным runtime.
   Для запуска инструмента нужны Node и artifacts, исходники/npm packages не нужны.
2. Подготовьте отдельную **offline** копию deployment из доверенного snapshot,
   например `staging/catalog/releases/v1`. Остановите writers; не запускайте
   аттестацию в обслуживаемом каталоге. Сохраните исходную копию для восстановления.
3. Поместите expected inventory вне release directory и выполните:

```powershell
node ./tools/attest-release.mjs --directory ./staging/catalog/releases/v1 --inventory ./evidence/catalog-v1.json --sha256 <trusted-sha256> --module-id catalog --release-id v1
```

4. Успех — exit 0 и JSON `{ok:true,moduleId,releaseId,expectedInventorySha256}`.
   Нет обязательного аргумента, неверный digest/identity, лишний/пропавший/изменённый
   файл, недопустимый путь или invalid/hung renderer — exit 1, `attestation-failed`.
5. Инструмент сверяет полный набор и hashes до выполнения renderer и повторно после
   него. Перед записью он резервирует `<module-root>/.attestations/<releaseId>` через
   exclusive mkdir и перепроверяет originals. Добавляет отсутствующий server output
   manifest, `attestation.json` с digest свидетельства, `integrity.json` и последним
   `published.json`. Все записи `wx`: существующие файлы не заменяются.
6. После миграции всех нужных релизов запустите strict service в staging. Проверьте
   `/healthz`, `/readyz`, `/releases/v1/readyz`, manifest/render и browser assets.
   Затем следуйте rollout/rollback процедуре в `host.md`. Сам мигратор registry
   не переключает и production-допуск не выдаёт.

## Отказ и прерывание

Ошибки входного свидетельства и первичной проверки не создают publication metadata.
После начала записи crash может оставить metadata и reservation. Такой каталог
не ремонтируется автоматически: unmarked release не обслуживается, повреждённый
marked release даёт readiness 503. Сохраните журнал отказа, восстановите чистую
offline копию всего module staging из snapshot в **новом staging root**, затем
повторите аттестацию с тем же доверенным свидетельством. Не удаляйте наугад
sidecars/reservations из работающей поставки и не меняйте bytes под старым URL.
Повторная аттестация уже опубликованного каталога отклоняется.

Для object storage нельзя заменить atomic filesystem rename набором uploads:
публикуйте immutable objects, проверьте полноту по эталону и записывайте commit pointer
последним. Этот CLI предназначен для offline filesystem-копии, не для in-place CDN repair.

## Layout и порядок поставки

Новый builder использует один module-owned `outDir`:

```text
catalog/
  .module.json
  .reservations/<releaseId>/
  .staging/<attempt-uuid>/
  releases/<releaseId>/
    manifest.json
    assets/manifest.json + entries/shared/async/CSS/media
    server/emitted-manifest.json + server.mjs + chunks
    integrity.json
    published.json
  server.mjs
  package.json
```

`server.mjs` в корне — service binary, внутри release — renderer. Не смешивайте
outputs разных moduleId. Builder сначала эксклюзивно создаёт reservation, затем
собирает staging, проверяет renderer/полный граф/hashes, записывает inventory и
marker, повторно проверяет комплект и делает rename в `releases/<releaseId>`.
Staging и destination должны находиться на одном filesystem/volume.
Failed reservation сохраняется навсегда: следующая попытка получает **новый ID**,
а не удаляет lock. `.attestations/<releaseId>` — отдельная reservation мигратора.

При доставке на другой сервер не копируйте файлы сразу в обслуживаемый `releases`.
Доставьте полный комплект в отдельный offline staging на destination filesystem,
сверьте digests с доверенной build-записью, запретите других writers и только затем
переименуйте готовый release в свободный final path. Destination не заменяется;
эксклюзивное владение ID и отказ при существующем final path обязательны и для
deployment tooling. Перезапустите/явно перезагрузите service со старым и новым
релизами, проверьте readiness обоих, затем атомарно переключите registry хоста.

Для object storage порядок отдельный: reserve immutable module/release prefix,
upload всех объектов без overwrite, проверить inventory и доступность каждого
объекта через serving origin, последним условно создать commit pointer. Только
после этого включать release в registry. Нужен storage-specific adapter с
conditional-write semantics: встроенный filesystem loader не читает object store
и не реализует эту операцию. Наличие отдельных uploaded objects не есть publication.

## Rehearsal миграции и отката без исходников

1. В отдельный staging доставьте bundled service/host/attestor и доверенные
   snapshots v1/v2 с evidence; не доставляйте `src`, `node_modules`, `tsx`.
   Для реальной миграции нужны настоящие publisher evidence, не тестовый fixture.
2. Скопируйте snapshots в `offline/releases/v1` и `offline/releases/v2` и выполните
   CLI из раздела «Запуск» для каждого ID. Сравните hashes **всех исходных файлов**
   с expected inventory; новые metadata не должны менять старые bytes/URL.
3. Переименуйте готовый offline module tree в новый `live` на том же volume.
   Запустите strict service с этим `releases` и host с отдельным registry. До
   переключения проверьте health, aggregate/per-release readiness (200), manifest,
   POST render и browser assets обоих релизов, их MIME/CORS.
4. Запишите registry с v1 во временный соседний файл и выполните rename. Проверьте
   SSR v1; аналогично переключите v2, затем верните v1 **без restart/rebuild host**.
   Не удаляйте v1/v2: уже открытые страницы сохраняют свои URLs.
5. Повторно сравните hashes original files и host binary; сохраните версии runtime,
   digest свидетельств и последовательность проверок. Отказ любого probe не
   разрешает переключение. Для отката framework binary используйте прежний
   проверенный snapshot с совместимой конфигурацией, сохраняя release directories.

Автоматизация этих шагов: `node --import tsx --test tests/migration-rollback.test.ts`.
Команда запускается на build/test машине; внутри создаётся отдельный OS temp
staging, bundled CLI/host/service работают дочерним **обычным Node** с пустыми
`NODE_PATH`/`NODE_OPTIONS`, без sources/packages. `evidence.json` сохраняет runtime,
платформу, digests и результат. Тест использует синтетическое доверенное CI
свидетельство, а не аттестует реальные старые каталоги приложений. Cold browser
import проверяется отдельно в `tests/cold-release.e2e.ts`; rehearsal не заменяет
CDN/production qualification.

Регрессии: `node --import tsx --test tests/attestation.test.ts` проверяют сохранение
bytes, missing lazy chunks, лишние файлы, неверные digests/identity/paths, bounded
renderer, конкуренцию, отказ без evidence и запуск bundled CLI без исходников.
