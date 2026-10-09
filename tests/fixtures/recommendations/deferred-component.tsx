import { useState } from "react"
import { useHydrated } from "@islands/client/react"

export function Deferred({ data }: { data: { release: string } }) {
  const ready = useHydrated()
  const [count, setCount] = useState(0)
  return (
    <section data-deferred={data.release}>
      <p>Deferred {data.release}</p>
      <button disabled={!ready} onClick={() => setCount((value) => value + 1)}>
        Deferred count {count}
      </button>
    </section>
  )
}
