import { useState } from "react"
import styles from "./view.module.css"
export function Counter() {
  const [count, setCount] = useState(1)
  return (
    <button className={styles.counter} onClick={() => setCount(count + 1)}>
      Count {count}
    </button>
  )
}
