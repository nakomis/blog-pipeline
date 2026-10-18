import { createContext, useContext, useId } from 'react';
import type { ReactNode } from 'react';
import type { LinkSuggestion, SuggestionDecision } from '../api/post-detail';

/**
 * Inline link suggestions in the rendered article (PIPE-38).
 *
 * A remark plugin finds each suggestion's anchor text in the article's prose and
 * wraps it in a `<mark>`; `SuggestionMark` renders that mark as a focusable
 * highlight whose popover (on hover or keyboard focus) shows Haiku's reason and
 * the Accept / Reject controls. The Markdown source is never changed here:
 * accepted links merely *look* like links, marked "applied on approval", until
 * the post is approved.
 */

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** Node types whose text must never carry a suggestion. */
const OPAQUE = new Set([
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

function markNode(link: LinkSuggestion): MdastNode {
  return {
    type: 'suggestionMark',
    data: { hName: 'mark', hProperties: { 'data-suggestion-id': link.id } },
    children: [{ type: 'text', value: link.anchorText }],
  };
}

function splitText(node: MdastNode, links: LinkSuggestion[]): MdastNode[] {
  const value = node.value ?? '';
  const hits = links
    .map((link) => ({ link, at: value.indexOf(link.anchorText) }))
    .filter((h) => h.at !== -1)
    .sort((a, b) => a.at - b.at);
  if (hits.length === 0) {
    return [node];
  }
  const out: MdastNode[] = [];
  let cursor = 0;
  for (const { link, at } of hits) {
    if (at < cursor) {
      continue; // overlaps an earlier highlight
    }
    if (at > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, at) });
    }
    out.push(markNode(link));
    cursor = at + link.anchorText.length;
  }
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) });
  }
  return out;
}

function walk(node: MdastNode, links: LinkSuggestion[]): void {
  if (!node.children || OPAQUE.has(node.type)) {
    return;
  }
  const next: MdastNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text') {
      next.push(...splitText(child, links));
    } else {
      walk(child, links);
      next.push(child);
    }
  }
  node.children = next;
}

/**
 * A remark plugin that highlights each non-rejected suggestion's anchor text.
 * Rejected suggestions lose their highlight; anchors that no longer occur in a
 * plain text node (stale, or split by emphasis) are simply not highlighted and
 * are reported by `unplacedLinks`.
 */
export function suggestionPlugin(links: LinkSuggestion[]) {
  const active = links.filter((l) => l.decision !== 'rejected');
  return () => (tree: MdastNode) => {
    if (active.length > 0) {
      walk(tree, active);
    }
  };
}

/** Suggestions whose anchor no longer occurs exactly once in the article. */
export function staleLinks(links: LinkSuggestion[], markdown: string): LinkSuggestion[] {
  return links.filter((l) => {
    let count = 0;
    let from = 0;
    for (;;) {
      const at = markdown.indexOf(l.anchorText, from);
      if (at === -1) {
        break;
      }
      count += 1;
      from = at + l.anchorText.length;
    }
    return count !== 1;
  });
}

interface SuggestionContextValue {
  byId: Map<string, LinkSuggestion>;
  onDecide: (id: string, decision: SuggestionDecision) => void;
  /** Decisions can only be changed while the post is staged. */
  editable: boolean;
}

const SuggestionContext = createContext<SuggestionContextValue | null>(null);

export function SuggestionProvider({
  links,
  onDecide,
  editable,
  children,
}: {
  links: LinkSuggestion[];
  onDecide: (id: string, decision: SuggestionDecision) => void;
  editable: boolean;
  children: ReactNode;
}) {
  const byId = new Map(links.map((l) => [l.id, l]));
  return (
    <SuggestionContext.Provider value={{ byId, onDecide, editable }}>
      {children}
    </SuggestionContext.Provider>
  );
}

/** Renders one highlighted anchor with its hover / focus popover. */
export function SuggestionMark({
  node: _node,
  children,
  ...props
}: Record<string, unknown> & { children?: ReactNode }) {
  const ctx = useContext(SuggestionContext);
  const popoverId = useId();
  const id = props['data-suggestion-id'] as string | undefined;
  const link = id ? ctx?.byId.get(id) : undefined;
  if (!ctx || !link) {
    return <>{children}</>;
  }
  const accepted = link.decision === 'accepted';

  return (
    <span className={`sugg sugg--${link.decision}`}>
      {accepted ? (
        <a
          className="sugg__mark sugg__mark--accepted"
          href={link.targetUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby={popoverId}
        >
          {children}
        </a>
      ) : (
        <mark className="sugg__mark" tabIndex={0} aria-describedby={popoverId}>
          {children}
        </mark>
      )}
      <span role="tooltip" id={popoverId} className="sugg__pop">
        <strong className="sugg__title">
          {accepted ? 'Link applied on approval' : 'Suggested link'}
        </strong>
        <span className="sugg__target">
          {link.targetTitle} <span className="sugg__date">({link.targetDate})</span>
        </span>
        <span className="sugg__reason">{link.reason}</span>
        {ctx.editable && (
          <span className="sugg__actions">
            {link.decision === 'pending' ? (
              <>
                <button
                  type="button"
                  className="btn btn--small btn--primary"
                  onClick={() => ctx.onDecide(link.id, 'accepted')}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => ctx.onDecide(link.id, 'rejected')}
                >
                  Reject
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => ctx.onDecide(link.id, 'rejected')}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className="btn btn--small"
                  onClick={() => ctx.onDecide(link.id, 'pending')}
                >
                  Undo
                </button>
              </>
            )}
          </span>
        )}
      </span>
    </span>
  );
}
