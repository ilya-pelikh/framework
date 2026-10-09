import { bootstrap, dispose } from "@islands/client"
const onError = (diagnostic: unknown) => console.error("island-error", diagnostic)
bootstrap(undefined, { onError })
Object.assign(window, {
  islands: { bootstrap: () => bootstrap(undefined, { onError }), dispose },
})
