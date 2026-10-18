/**
 * Shared helpers for highlighting words in the rendered article: a tiny mdast
 * walker that hands each prose text node to a splitter. Used by the link
 * suggestions (PIPE-38) and the affiliate mentions (PIPE-41).
 */

export interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** Node types whose text must never carry a suggestion. */
export const OPAQUE = new Set([
  'heading',
  'link',
  'linkReference',
  'code',
  'inlineCode',
  'image',
  'imageReference',
  'html',
  'definition',
]);


/** Replace each prose text node with whatever `split` returns; opaque nodes are left alone. */
export function walkText(node: MdastNode, split: (text: MdastNode) => MdastNode[]): void {
  if (!node.children || OPAQUE.has(node.type)) {
    return;
  }
  const next: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      next.push(...split(child));
    } else {
      walkText(child, split);
      next.push(child);
    }
  }
  node.children = next;
}
