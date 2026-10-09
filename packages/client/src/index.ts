import { parseBrowserIsland, type BrowserIsland, type Json } from "@islands/contracts"
export interface HydrateOptions {
  identifierPrefix: string
  onError: (category: string) => void
}
export interface IslandEntry {
  hydrate(element: HTMLElement, props: Json, options: HydrateOptions): () => void
}
export interface BrowserDiagnostic {
  moduleId?: string
  releaseId?: string
  island?: string
  category: string
}
export interface BootstrapOptions {
  document?: Document
  importEntry?: (url: string) => Promise<IslandEntry>
  onError?: (diagnostic: BrowserDiagnostic) => void
}
interface State {
  id: string
  element?: HTMLElement
  disposed: boolean
  started: boolean
  cancel?: () => void
  unmount?: () => void
  report?: (category: string) => void
}
interface Scope {
  seen: Set<string>
  active: Map<string, State>
}
const scopes = new WeakMap<Document, Scope>()
const imports = new Map<string, Promise<IslandEntry>>()

function cancel(state: State) {
  const callback = state.cancel
  delete state.cancel
  try {
    callback?.()
  } catch {
    state.report?.("cleanup")
  }
}
function release(scope: Scope, state: State) {
  if (state.disposed) return
  state.disposed = true
  cancel(state)
  const unmount = state.unmount
  delete state.unmount
  try {
    unmount?.()
  } catch {
    state.report?.("cleanup")
  } finally {
    delete state.element
    delete state.report
    scope.active.delete(state.id)
  }
}
export function dispose(id?: string, doc: Document = document) {
  const scope = scopes.get(doc)
  if (!scope) return
  for (const [key, state] of scope.active) if (id === undefined || id === key) release(scope, state)
}
export function bootstrap(islands?: BrowserIsland[], options: BootstrapOptions = {}) {
  const doc = options.document ?? document
  const emit = (category: string, island?: BrowserIsland) => {
    try {
      options.onError?.({
        category,
        ...(island
          ? {
              moduleId: island.moduleId,
              releaseId: island.releaseId,
              island: island.id,
            }
          : {}),
      })
    } catch {}
  }
  let payload: unknown[]
  try {
    if (islands !== undefined) {
      if (!Array.isArray(islands)) throw new Error("Invalid descriptor list")
      payload = islands
    } else {
      const scripts = doc.querySelectorAll('[id="islands-payload"]')
      if (scripts.length === 0 && !doc.querySelector("[data-island]")) return () => {}
      const script = scripts[0]
      if (scripts.length !== 1 || script?.tagName !== "SCRIPT" || script.getAttribute("type") !== "application/json")
        throw new Error("Invalid payload script")
      const values: unknown = JSON.parse(script.textContent ?? "")
      if (!Array.isArray(values)) throw new Error("Invalid payload")
      payload = values.map(parseBrowserIsland)
      const ids = new Set(payload.map((value) => (value as BrowserIsland).id))
      if (ids.size !== payload.length) throw new Error("Duplicate payload ID")
    }
  } catch {
    emit("payload")
    return () => {}
  }
  let scope = scopes.get(doc)
  if (!scope) {
    scope = { seen: new Set(), active: new Map() }
    scopes.set(doc, scope)
  }
  const documentScope = scope
  const selected: State[] = []
  const importer = options.importEntry ?? ((url) => import(/* webpackIgnore: true */ url))
  const view = doc.defaultView
  for (const raw of payload) {
    let island: BrowserIsland
    // Document payload was validated atomically above; explicit entries fail independently.
    try {
      island = islands === undefined ? (raw as BrowserIsland) : parseBrowserIsland(raw)
    } catch {
      emit("descriptor")
      continue
    }
    if (documentScope.seen.has(island.id)) continue
    const element = doc.getElementById(island.id)
    if (!element || element.getAttribute("data-island") !== island.islandKey) {
      emit("missing-container", island)
      continue
    }
    if (island.policy === "never") continue
    documentScope.seen.add(island.id)
    const state: State = {
      id: island.id,
      element,
      disposed: false,
      started: false,
      report: (category) => emit(category, island),
    }
    documentScope.active.set(island.id, state)
    selected.push(state)
    const unavailable = (category: string) => {
      if (state.disposed) return
      if (state.element) state.element.dataset.islandUnavailable = "true"
      state.report?.(category)
      release(documentScope, state)
    }
    const start = async () => {
      if (state.disposed || state.started) return
      if (!state.element?.isConnected) {
        unavailable("missing-container")
        return
      }
      state.started = true
      cancel(state)
      let entry: IslandEntry
      try {
        let pending = imports.get(island.clientEntryUrl)
        if (!pending) {
          pending = Promise.resolve().then(() => importer(island.clientEntryUrl))
          imports.set(island.clientEntryUrl, pending)
        }
        entry = await pending
      } catch {
        unavailable("import")
        return
      }
      if (state.disposed) return
      if (!state.element?.isConnected) {
        unavailable("missing-container")
        return
      }
      if (!entry || typeof entry.hydrate !== "function") {
        unavailable("entry-contract")
        return
      }
      try {
        const unmount = entry.hydrate(state.element, island.props, {
          identifierPrefix: island.identifierPrefix,
          onError: (category) => state.report?.(category),
        })
        if (typeof unmount !== "function") {
          unavailable("entry-contract")
          return
        }
        if (state.disposed) {
          try {
            unmount()
          } catch {
            emit("cleanup", island)
          }
          return
        }
        state.unmount = unmount
        state.element.dataset.hydrated = "true"
      } catch {
        unavailable("hydrate")
      }
    }
    if (island.policy === "visible" && view && typeof view.IntersectionObserver === "function") {
      const observer = new view.IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void start()
      })
      state.cancel = () => observer.disconnect()
      observer.observe(element)
    } else if (island.policy === "idle") {
      if (view && typeof view.requestIdleCallback === "function") {
        const handle = view.requestIdleCallback(() => void start(), {
          timeout: 2000,
        })
        state.cancel = () => view.cancelIdleCallback(handle)
      } else {
        const handle = setTimeout(() => void start(), 200)
        state.cancel = () => clearTimeout(handle)
      }
    } else {
      void start()
    }
  }
  return () => {
    for (const state of selected) release(documentScope, state)
  }
}
