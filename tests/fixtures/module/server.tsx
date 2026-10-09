import { renderToString } from "react-dom/server"
import { Counter } from "./view.tsx"
export function render() {
  return renderToString(<Counter />)
}
