# Добавление третьего модуля

Создайте workspace-пакет `apps/recommendations` и объявите зависимости от React,
React DOM, `@islands/server` и `@islands/client` с зафиксированными версиями.
Используйте структуру компонента, точки входа и фрагмента из каталога.
Изменять среду выполнения фреймворка не требуется.

```tsx
import { defineIsland, defineFragment } from "@islands/server"
function Recommendation({ data }: { data: { message: string } }) {
  return <p>{data.message}</p>
}
const island = defineIsland("recommendation", Recommendation, "never")
export const render = defineFragment((builder) => builder.island(island, { message: "Try a pear" }))
```

Браузерная точка входа экспортирует `hydrate` из `createIslandEntry(Recommendation)`.
Для сборки используйте
`buildRelease({root, moduleId:'recommendations', releaseId:'v1', publicOrigin:'http://localhost:4104', serverEntry, islands:{recommendation:entry}})`.
Возьмите `scripts/service-entry.ts` за образец запуска Express:
вызовите `loadPublishedReleases(releasesDirectory, onDiagnostic)` и передайте
полученные `releases` и `invalidReleases` в `createModuleService`.
Каждый release содержит `releaseDirectory`, `assetsDirectory`, manifest и renderer.
Unmarked каталоги не загружаются; повреждённый marked release делает readiness
неуспешной, не отключая исправные соседние endpoints.
Настройте в этом сервисе список разрешённых origin хоста.

Добавьте localhost:4104 в `allowedOrigins` хоста.
Атомарно добавьте в реестр запись
`recommendations: {releaseId:'v1', manifestUrl:'http://localhost:4104/releases/v1/manifest.json'}`.
В таблицу маршрутов добавьте слот с `moduleId:'recommendations'`, JSON-props
и резервным содержимым на случай ошибки, а в оболочку — HTML этого слота по его имени.
Это изменения конфигурации приложения: правки контрактов, серверной или браузерной
среды выполнения не нужны. CSS и дескрипторы поступят через обычный механизм композиции.

Запустите `npm test`: тест `extension.test.ts` повторяет этот подход с третьим
тестовым сервисом и хостом, используя только публичные API.
Для production-модуля также выполните независимую сборку и браузерные проверки
загрузки с другого origin. Выпуск и откат описаны в `host.md`;
при изменении реестра сохраняйте адреса рендеринга и ресурсы старых релизов.

Используйте `builder.island` для живых wrappers: не помещайте их в `template`,
`noscript`, `inert` или другие islands. Префикс ID `islands-`, атрибуты
`data-islands-*` и служебные comment markers не доступны модулю. Остальные ID
делайте уникальными для каждого экземпляра. Props — plain JSON без hooks и
дополнительных свойств массивов. Shell вставляет каждый slot-string целиком и
ровно один раз; fallback не объявляет islands. Ошибка одного модуля не должна
отключать соседа: проверяйте это отдельно от happy-path теста.

Исполняемый пример independent build + cross-origin React hydration + CSS/MIME/CORS:
`node --import tsx --test tests/extension.e2e.ts`.
Его исходники находятся в `tests/fixtures/recommendations`; проверяется pinned
React/React DOM 19.3.0, точность script-like/Unicode props и отсутствие mismatch.
