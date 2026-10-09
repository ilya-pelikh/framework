import { defineFragment, defineIsland } from "@islands/server"
import { Cart } from "./view.tsx"
declare const __RELEASE_ID__: string
const island = defineIsland("cart", Cart, "visible")
export const render = defineFragment((builder, request) => {
  const props = request.props as {
    policy?: "load" | "visible" | "idle" | "never"
    title?: string
  }
  return builder.island(
    island,
    { title: props.title ?? "Cart", initial: 1, release: __RELEASE_ID__ },
    props.policy ?? "visible",
  )
})
