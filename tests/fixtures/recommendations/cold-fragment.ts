import { defineFragment, defineIsland } from "@islands/server"
import { Recommendation } from "./component.tsx"
import { Deferred } from "./deferred-component.tsx"
const neighbor = defineIsland("neighbor", Recommendation, "load")
const delayed = defineIsland("delayed", Deferred, "idle")
export const render = defineFragment(
  (builder, request) =>
    builder.island(neighbor, { message: "Neighbor" }) + builder.island(delayed, { release: request.releaseId }),
)
