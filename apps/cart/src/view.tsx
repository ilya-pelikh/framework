import { useId, useState } from "react"
import { useHydrated } from "@islands/client/react"
import styles from "./view.module.css"
export type CartData = { title: string; initial: number; release: string }
export function Cart({ data }: { data: CartData }) {
  const [count, setCount] = useState(data.initial)
  const hydrated = useHydrated()
  const id = useId()
  return (
    <section className={styles.cart}>
      <h2>
        {data.title} ({data.release})
      </h2>
      <p id={id}>Quantity: {count}</p>
      <button disabled={!hydrated} aria-describedby={id} onClick={() => setCount(count + 1)}>
        Add one
      </button>
    </section>
  )
}
