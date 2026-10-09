import { defineFragment, defineIsland } from "@islands/server"
import { Catalog } from "./view.tsx"
declare const __RELEASE_ID__: string
const island = defineIsland("catalog", Catalog)
export const render = defineFragment((builder, request) => {
  const props = request.props as {
    policy?: "load" | "visible" | "idle" | "never"
    title?: string
    crash?: boolean
  }
  return builder.island(
    island,
    {
      title: props.title ?? "Catalog",
      release: __RELEASE_ID__,
      ...(props.crash ? { crash: true } : {}),
    },
    props.policy ?? "load",
  )
})
