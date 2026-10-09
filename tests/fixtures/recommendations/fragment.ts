import { defineFragment, defineIsland } from "@islands/server"
import { Recommendation } from "./component.tsx"
const recommendation = defineIsland("recommendation", Recommendation, "load")
export const render = defineFragment((builder, request) =>
  builder.island(recommendation, request.props as { message: string }),
)
export const loadDetails = () => import("./lazy.ts")
