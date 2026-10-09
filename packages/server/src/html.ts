import { parseFragment, type DefaultTreeAdapterTypes } from "parse5"

export type HtmlNode = DefaultTreeAdapterTypes.Node
export function attributes(node: HtmlNode): Record<string, string> {
  return Object.fromEntries("attrs" in node ? node.attrs.map((attribute) => [attribute.name, attribute.value]) : [])
}
export function children(node: HtmlNode): HtmlNode[] {
  return "childNodes" in node ? node.childNodes : []
}
export function isReservedId(value: string): boolean {
  return value.startsWith("islands-")
}
export function validateFragmentMarkup(html: string): HtmlNode {
  const root = parseFragment(html, { sourceCodeLocationInfo: true })
  function visit(node: HtmlNode) {
    const attrs = attributes(node)
    if ("data" in node && node.nodeName === "#comment" && node.data.trimStart().startsWith("islands-"))
      throw new Error("Reserved composition marker")
    if (isReservedId(attrs.id ?? "") || Object.keys(attrs).some((name) => name.startsWith("data-islands-")))
      throw new Error("Reserved framework namespace")
    if ("tagName" in node && node.tagName === "script") throw new Error("Scripts are forbidden in fragments")
    for (const child of children(node)) visit(child)
    if ("content" in node) visit(node.content)
  }
  visit(root)
  return root
}
