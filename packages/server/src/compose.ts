import { randomUUID } from "node:crypto"
import { parse } from "parse5"
import type { IslandDescriptor } from "@islands/contracts"
import { attributes, children, isReservedId, validateFragmentMarkup, type HtmlNode } from "./html.ts"

export interface CompositionSlot {
  name: string
  html: string
  fallback: string
  islands: IslandDescriptor[]
  failed?: boolean
}
export function composeSlots(slots: CompositionSlot[], shell?: (slots: Record<string, string>) => string) {
  const token = randomUUID()
  const markers = slots.map((_slot, index) => ({
    start: `islands-slot:${token}:${index}:start`,
    end: `islands-slot:${token}:${index}:end`,
  }))
  const inputs: Record<string, string> = Object.create(null)
  const rejected = new Set<number>()
  slots.forEach((slot, index) => {
    if (Object.hasOwn(inputs, slot.name)) throw new Error("Duplicate slot name")
    if (slot.failed) {
      validateFragmentMarkup(slot.fallback)
      rejected.add(index)
    }
    const marker = markers[index]!
    inputs[slot.name] = `<!--${marker.start}-->${slot.html}<!--${marker.end}-->`
  })
  let body = shell ? shell(inputs) : Object.values(inputs).join("")
  if (typeof body !== "string") throw new Error("Invalid shell")
  for (let iteration = 0; iteration <= slots.length; iteration++) {
    const prefix = "<!doctype html><html><head></head><body>"
    const documentHtml = `${prefix}${body}</body></html>`
    const ranges = markers.map((marker) => {
      const startText = `<!--${marker.start}-->`
      const endText = `<!--${marker.end}-->`
      const start = documentHtml.indexOf(startText)
      const end = documentHtml.indexOf(endText)
      if (
        start < 0 ||
        end < start ||
        documentHtml.indexOf(startText, start + 1) !== -1 ||
        documentHtml.indexOf(endText, end + 1) !== -1
      )
        throw new Error("Shell must include each slot exactly once")
      return { start, end, contentStart: start + startText.length }
    })
    const sorted = [...ranges].sort((left, right) => left.start - right.start)
    for (let index = 1; index < sorted.length; index++)
      if (sorted[index]!.start < sorted[index - 1]!.end) throw new Error("Overlapping slot boundaries")
    const failures = new Set<number>()
    const fail = (owner: number | undefined) => {
      if (owner === undefined || rejected.has(owner)) throw new Error("Invalid shell or fallback")
      failures.add(owner)
    }
    const sourceOwner = (node: HtmlNode) => {
      const position = node.sourceCodeLocation?.startOffset
      if (position === undefined) return undefined
      const index = ranges.findIndex((range) => position >= range.contentStart && position < range.end)
      return index < 0 ? undefined : index
    }
    const root = parse(documentHtml, { sourceCodeLocationInfo: true })
    const nodes: HtmlNode[] = []
    const inert = new Set<HtmlNode>()
    const visit = (node: HtmlNode, inactive = false) => {
      inactive ||= "inert" in attributes(node) || ("tagName" in node && ["template", "noscript"].includes(node.tagName))
      nodes.push(node)
      if (inactive) inert.add(node)
      for (const child of children(node)) visit(child, inactive)
      if ("content" in node) visit(node.content, true)
    }
    visit(root)
    const domOwners = new Map<HtmlNode, number>()
    const assign = (node: HtmlNode, index: number) => {
      const previous = domOwners.get(node)
      if (previous !== undefined && previous !== index) {
        fail(index)
        fail(previous)
      }
      domOwners.set(node, index)
      for (const child of children(node)) assign(child, index)
      if ("content" in node) assign(node.content, index)
    }
    markers.forEach((marker, index) => {
      const start = nodes.find((node) => "data" in node && node.data === marker.start)
      const end = nodes.find((node) => "data" in node && node.data === marker.end)
      if (
        !start ||
        !end ||
        !("parentNode" in start) ||
        !("parentNode" in end) ||
        !start.parentNode ||
        start.parentNode !== end.parentNode ||
        inert.has(start) ||
        inert.has(end)
      ) {
        fail(index)
        return
      }
      let ancestor: HtmlNode | null = start.parentNode
      while (ancestor && !("tagName" in ancestor && ancestor.tagName === "body"))
        ancestor = "parentNode" in ancestor ? ancestor.parentNode : null
      if (!ancestor) {
        fail(index)
        return
      }
      const siblings = children(start.parentNode)
      const first = siblings.indexOf(start)
      const last = siblings.indexOf(end)
      if (first >= last) {
        fail(index)
        return
      }
      for (const node of siblings.slice(first + 1, last)) assign(node, index)
    })
    const elements = nodes.filter((node) => "tagName" in node)
    for (const node of elements) {
      const source = sourceOwner(node)
      const owner = domOwners.get(node)
      if (node.sourceCodeLocation && source !== owner) {
        fail(source)
        if (owner !== undefined) fail(owner)
      }
    }
    const seenIds = new Set<string>()
    for (const node of elements.sort((left, right) => (sourceOwner(left) ?? -1) - (sourceOwner(right) ?? -1))) {
      const attrs = attributes(node)
      const owner = sourceOwner(node)
      if (owner !== undefined && failures.has(owner)) continue
      if (isReservedId(attrs.id ?? "") || Object.keys(attrs).some((name) => name.startsWith("data-islands-"))) {
        fail(owner)
        continue
      }
      if (attrs.id) {
        if (seenIds.has(attrs.id)) {
          fail(owner)
          continue
        }
        seenIds.add(attrs.id)
      }
      if ("data-island" in attrs) {
        if (owner === undefined) throw new Error("Shell cannot declare islands")
        const descriptor = slots[owner]!.islands.find((island) => island.id === attrs.id)
        if (rejected.has(owner) || !descriptor || descriptor.islandKey !== attrs["data-island"] || inert.has(node)) {
          fail(owner)
          continue
        }
        let parent = "parentNode" in node ? node.parentNode : null
        while (parent) {
          if ("data-island" in attributes(parent)) {
            fail(owner)
            break
          }
          parent = "parentNode" in parent ? parent.parentNode : null
        }
      }
    }
    slots.forEach((slot, index) => {
      if (rejected.has(index) || failures.has(index)) return
      for (const island of slot.islands) {
        if (
          !elements.some(
            (node) =>
              domOwners.get(node) === index &&
              attributes(node).id === island.id &&
              attributes(node)["data-island"] === island.islandKey,
          )
        )
          fail(index)
      }
    })
    if (!failures.size) return { body, rejected }
    for (const index of [...failures].sort((left, right) => ranges[right]!.start - ranges[left]!.start)) {
      const slot = slots[index]!
      validateFragmentMarkup(slot.fallback)
      const range = ranges[index]!
      const offset = prefix.length
      body = body.slice(0, range.contentStart - offset) + slot.fallback + body.slice(range.end - offset)
      rejected.add(index)
    }
  }
  throw new Error("Composition did not converge")
}
