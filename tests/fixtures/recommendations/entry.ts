import { createIslandEntry } from "@islands/client/react"
import { Recommendation } from "./component.tsx"
export const { hydrate } = createIslandEntry(Recommendation)
export const loadDetails = () => import("./lazy.ts")
