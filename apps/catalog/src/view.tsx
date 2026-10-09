import { useId, useState } from "react"
import { useHydrated } from "@islands/client/react"
import styles from "./view.module.css"
export type CatalogData = { title: string; release: string; crash?: boolean }
export function Catalog({ data }: { data: CatalogData }) {
  const [filter, setFilter] = useState("")
  const hydrated = useHydrated()
  const id = useId()
  if (filter === "crash" && data.crash) throw new Error("Fixture render failure")
  return (
    <section className={styles.catalog}>
      <h2>
        {data.title} ({data.release})
      </h2>
      <label htmlFor={id}>Filter products</label>
      <input id={id} disabled={!hydrated} value={filter} onChange={(event) => setFilter(event.target.value)} />
      <ul>
        {["Apple", "Banana", "Pear"]
          .filter((name) => name.toLowerCase().includes(filter.toLowerCase()))
          .map((name) => (
            <li key={name}>{name}</li>
          ))}
      </ul>
    </section>
  )
}
