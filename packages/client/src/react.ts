import { Component, createElement, useEffect, useState, type ComponentType, type ReactNode } from "react"
import { hydrateRoot } from "react-dom/client"
import type { Json } from "@islands/contracts"
import type { IslandEntry } from "./index.ts"

class IslandBoundary extends Component<
  { children: ReactNode; onError: (category: string) => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    this.props.onError("render")
  }
  render() {
    return this.state.failed
      ? createElement("p", { role: "alert" }, "This control is unavailable.")
      : this.props.children
  }
}
export function useHydrated() {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  return hydrated
}
export function createIslandEntry<P extends Json>(component: ComponentType<{ data: P }>): IslandEntry {
  return {
    hydrate(element, props, options) {
      const root = hydrateRoot(
        element,
        createElement(IslandBoundary, {
          onError: options.onError,
          children: createElement(component, { data: props as P }),
        }),
        {
          identifierPrefix: options.identifierPrefix,
          onRecoverableError: () => options.onError("mismatch"),
        },
      )
      return () => root.unmount()
    },
  }
}
