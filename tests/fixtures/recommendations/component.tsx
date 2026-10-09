import { useId, useState } from "react"
import { useHydrated } from "@islands/client/react"
import styles from "./style.module.css"

export function Recommendation({ data }: { data: { message: string } }) {
  const label = useId()
  const hydrated = useHydrated()
  const [count, setCount] = useState(0)
  return (
    <section className={styles.recommendation}>
      <label htmlFor={label}>{data.message}</label>
      <button id={label} disabled={!hydrated} onClick={() => setCount((value) => value + 1)}>
        Choose {count}
      </button>
    </section>
  )
}
