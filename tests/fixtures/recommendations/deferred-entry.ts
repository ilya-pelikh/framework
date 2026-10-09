import { createIslandEntry } from "@islands/client/react"
const { Deferred } = await import("./deferred-component.tsx")
export const { hydrate } = createIslandEntry(Deferred)
