import { createElement, type ComponentType, type ReactNode } from "react"
import { renderToString } from "react-dom/server"
import { attributes, children, validateFragmentMarkup, type HtmlNode } from "./html.ts"
import {
  assertJson,
  escapeAttribute,
  id,
  parseRenderRequest,
  parseRenderResponse,
  type Json,
  type Manifest,
  type Policy,
  type RenderRequest,
  type RenderResponse,
  type IslandDescriptor,
} from "@islands/contracts"

export interface Island<P extends Json = Json> {
  key: string
  component: ComponentType<{ data: P }>
  policy: Policy
}
export function defineIsland<P extends Json>(
  key: string,
  component: ComponentType<{ data: P }>,
  policy: Policy = "load",
): Island<P> {
  id(key)
  if (!["load", "visible", "idle", "never"].includes(policy)) throw new Error("Invalid policy")
  return { key, component, policy }
}
export interface FragmentBuilder {
  island<P extends Json>(island: Island<P>, props: P, policy?: Policy): string
  static(node: ReactNode): string
}
export type FragmentRenderer = (request: RenderRequest) => RenderResponse
export function defineFragment(render: (builder: FragmentBuilder, request: RenderRequest) => string): FragmentRenderer {
  return (input) => {
    const request = parseRenderRequest(input)
    const islands: IslandDescriptor[] = []
    let rendering = false
    const builder: FragmentBuilder = {
      island(island, props, policy = island.policy) {
        if (rendering) throw new Error("Nested island declaration")
        assertJson(props)
        const instanceId = `${request.instanceId}-${islands.length}`
        const identifierPrefix = `${instanceId}-`
        rendering = true
        let html: string
        try {
          html = renderToString(createElement(island.component, { data: props }), { identifierPrefix })
        } finally {
          rendering = false
        }
        islands.push({
          id: instanceId,
          identifierPrefix,
          islandKey: island.key,
          props,
          policy,
        })
        return `<div id="${escapeAttribute(instanceId)}" data-island="${escapeAttribute(island.key)}">${html}</div>`
      },
      static(node) {
        if (rendering) throw new Error("Nested fragment rendering")
        rendering = true
        try {
          return renderToString(node)
        } finally {
          rendering = false
        }
      },
    }
    const response = parseRenderResponse({
      protocolVersion: 1,
      moduleId: request.moduleId,
      releaseId: request.releaseId,
      html: render(builder, request),
      islands,
    })
    validateFragment(response)
    return response
  }
}

export function validateFragment(response: RenderResponse, manifest?: Manifest, instanceId?: string): void {
  const descriptors = new Map(response.islands.map((island) => [island.id, island]))
  const found = new Set<string>()
  const domIds = new Set<string>()
  function visit(node: HtmlNode, insideIsland: boolean, inert = false) {
    const attrs = attributes(node)
    inert ||= "inert" in attrs || ("tagName" in node && ["template", "noscript"].includes(node.tagName))
    if (attrs.id) {
      if (domIds.has(attrs.id)) throw new Error("Duplicate DOM ID")
      domIds.add(attrs.id)
    }
    if ("data-island" in attrs) {
      if (inert) throw new Error("Inert island wrapper")
      if (insideIsland) throw new Error("Nested island wrapper")
      const descriptor = descriptors.get(attrs.id!)
      if (!descriptor || descriptor.islandKey !== attrs["data-island"]) throw new Error("Wrapper mismatch")
      if (manifest && !Object.hasOwn(manifest.islands, descriptor.islandKey)) throw new Error("Unknown island key")
      if (
        instanceId &&
        (!descriptor.id.startsWith(`${instanceId}-`) || descriptor.identifierPrefix !== `${descriptor.id}-`)
      )
        throw new Error("Instance identity mismatch")
      if (found.has(descriptor.id)) throw new Error("Repeated wrapper")
      found.add(descriptor.id)
      insideIsland = true
    }
    for (const child of children(node)) visit(child, insideIsland, inert)
    if ("content" in node) visit(node.content, insideIsland, true)
  }
  visit(validateFragmentMarkup(response.html), false)
  if (found.size !== descriptors.size) throw new Error("Missing island wrapper")
}
