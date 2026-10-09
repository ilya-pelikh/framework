import { hydrateRoot } from "react-dom/client"
import { Counter } from "./view.tsx"
export function hydrate(element: HTMLElement) {
  const root = hydrateRoot(element, <Counter />)
  return () => root.unmount()
}
