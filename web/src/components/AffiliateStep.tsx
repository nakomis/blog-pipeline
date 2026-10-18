import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Components } from 'react-markdown';
import type { AffiliateMention } from '../api/post-detail';
import { AffiliateRow } from './AffiliateRow';
import type { SaveResult } from './AffiliateRow';
import { walkText } from './markMarks';
import type { MdastNode } from './markMarks';

/**
 * The affiliate link step (PIPE-41): the article with each product mention
 * highlighted, and beside it one row per mention with a box for the SiteStripe
 * link. The model only pointed at words; the author pastes the links, the
 * server checks them, and they are written into the post when it is approved.
 */

// ── Highlighting ──────────────────────────────────────────────────────────

function splitAffiliate(
  node: MdastNode,
  mentions: AffiliateMention[],
  placed: Set<string>,
): MdastNode[] {
  const value = node.value ?? '';
  const hits: { m: AffiliateMention; at: number }[] = [];
  for (const m of mentions) {
    if (placed.has(m.id)) {
      continue;
    }
    // The anchor may appear many times in the article; its surrounding text
    // says which one is meant.
    const at = value.indexOf(m.before + m.anchorText + m.after);
    if (at !== -1) {
      hits.push({ m, at: at + m.before.length });
    }
  }
  if (hits.length === 0) {
    return [node];
  }
  hits.sort((a, b) => a.at - b.at);
  const out: MdastNode[] = [];
  let cursor = 0;
  for (const { m, at } of hits) {
    if (at < cursor) {
      continue;
    }
    placed.add(m.id);
    if (at > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, at) });
    }
    out.push({
      type: 'affiliateMark',
      data: { hName: 'mark', hProperties: { 'data-affiliate-id': m.id } },
      children: [{ type: 'text', value: m.anchorText }],
    });
    cursor = at + m.anchorText.length;
  }
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) });
  }
  return out;
}

/**
 * A remark plugin that wraps each mention, in the one sentence it was found
 * in, in a `<mark>`. A mention whose surrounding text is split across inline
 * formatting is simply not highlighted (its row is still there).
 */
export function affiliatePlugin(mentions: AffiliateMention[]) {
  return () => (tree: MdastNode) => {
    const placed = new Set<string>();
    walkText(tree, (node) => splitAffiliate(node, mentions, placed));
  };
}

/** Mentions whose surrounding text is no longer in the article exactly once. */
export function staleAffiliates(
  mentions: AffiliateMention[],
  markdown: string,
): AffiliateMention[] {
  return mentions.filter((m) => {
    const needle = m.before + m.anchorText + m.after;
    const first = markdown.indexOf(needle);
    return first === -1 || markdown.indexOf(needle, first + needle.length) !== -1;
  });
}

interface MarkContextValue {
  byId: Map<string, AffiliateMention>;
  activeId: string | null;
  onActivateMention: (id: string) => void;
}

const MarkContext = createContext<MarkContextValue | null>(null);

function AffiliateMark(props: Record<string, unknown> & { children?: ReactNode }) {
  const ctx = useContext(MarkContext);
  const id = props['data-affiliate-id'] as string | undefined;
  const mention = id ? ctx?.byId.get(id) : undefined;
  if (!ctx || !id || !mention) {
    return <mark>{props.children}</mark>;
  }
  return (
    <mark
      className={`aff-mark aff-mark--${mention.decision}${ctx.activeId === id ? ' aff-mark--active' : ''}`}
      data-affiliate-id={id}
      tabIndex={0}
      title={`Affiliate link: ${mention.productName}`}
      onFocus={() => ctx.onActivateMention(id)}
      onClick={() => ctx.onActivateMention(id)}
    >
      {props.children}
    </mark>
  );
}

// ── The step ──────────────────────────────────────────────────────────────

export interface AffiliateStepProps {
  mentions: AffiliateMention[];
  /** The article Markdown without frontmatter, to spot mentions the text has outgrown. */
  markdown: string;
  editable: boolean;
  /** The `amazon_tracking_id` in the author's source file, if any. */
  sourceTrackingId?: string;
  /** A per-post id typed in the bag. */
  typedTrackingId?: string;
  /** Renders the article with the highlight plugin and mark component applied. */
  renderArticle: (plugin: ReturnType<typeof affiliatePlugin>, components: Components) => ReactNode;
  onSave: (id: string, url: string) => Promise<SaveResult>;
  onSkip: (id: string) => void;
  onReset: (id: string) => void;
  onSkipRemaining: () => void;
  onSetTrackingId: (id: string | null) => Promise<{ ok: boolean; error?: string }>;
}

function TrackingId({
  source,
  typed,
  editable,
  onSet,
}: {
  source?: string;
  typed?: string;
  editable: boolean;
  onSet: (id: string | null) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const set = async (id: string | null) => {
    setError(null);
    try {
      const result = await onSet(id);
      if (result.ok) {
        setValue('');
      } else {
        setError(result.error ?? 'That tracking ID was not accepted.');
      }
    } catch (err) {
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (source) {
    return (
      <p className="aff__tracking">
        Tracking ID: <code>{source}</code> (from the source file)
      </p>
    );
  }
  return (
    <div className="aff__tracking">
      {typed ? (
        <p>
          Tracking ID: <code>{typed}</code> (entered here; added to the published post)
          {editable && (
            <>
              {' '}
              <button type="button" className="btn btn--small" onClick={() => void set(null)}>
                Clear
              </button>
            </>
          )}
        </p>
      ) : (
        <p className="aff__tracking-warning" role="status">
          This post has no amazon_tracking_id, so its links would earn under nakomis-21 and could not
          be attributed to the post. Create nakomis-bconn&lt;N&gt;-21 in Associates Central, then
          enter it below (or add it to the source file).
        </p>
      )}
      {editable && !typed && (
        <div className="aff__tracking-form">
          <label>
            <span>Per-post tracking ID</span>
            <input
              type="text"
              value={value}
              autoComplete="off"
              spellCheck={false}
              placeholder="nakomis-bconn66-21"
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && value.trim() !== '') {
                  e.preventDefault();
                  void set(value.trim());
                }
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn--small"
            disabled={value.trim() === ''}
            onClick={() => void set(value.trim())}
          >
            Use this ID
          </button>
        </div>
      )}
      {error && (
        <p className="aff-row__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function AffiliateStep({
  mentions,
  markdown,
  editable,
  sourceTrackingId,
  typedTrackingId,
  renderArticle,
  onSave,
  onSkip,
  onReset,
  onSkipRemaining,
  onSetTrackingId,
}: AffiliateStepProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const stale = new Set(staleAffiliates(mentions, markdown).map((m) => m.id));
  const live = mentions.filter((m) => !stale.has(m.id));
  const pending = mentions.filter((m) => m.decision === 'pending');

  // Start on the first mention that needs a link.
  useEffect(() => {
    if (!editable) {
      return;
    }
    const first = mentions.find((m) => m.decision === 'pending' && !stale.has(m.id));
    if (first) {
      inputs.current.get(first.id)?.focus();
    }
    // Only on first showing: later changes must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activate = (id: string) => {
    setActiveId(id);
    document
      .querySelector(`mark[data-affiliate-id="${id}"]`)
      ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  };

  const advance = (fromId: string) => {
    const at = mentions.findIndex((m) => m.id === fromId);
    const order = [...mentions.slice(at + 1), ...mentions.slice(0, Math.max(at, 0))];
    const next = order.find((m) => m.decision === 'pending' && !stale.has(m.id));
    if (next) {
      inputs.current.get(next.id)?.focus();
    }
  };

  const components: Components = {
    mark: (props) => <AffiliateMark {...(props as Record<string, unknown>)} />,
  };

  return (
    <section className="aff" aria-label="Affiliate links">
      <header className="aff__header">
        <TrackingId
          source={sourceTrackingId}
          typed={typedTrackingId}
          editable={editable}
          onSet={onSetTrackingId}
        />
        {mentions.length > 0 && (
          <p className="aff__hint">
            Paste the full amazon.co.uk link from SiteStripe and press <kbd>Enter</kbd> to save it
            and move to the next mention. <kbd>Shift</kbd>+<kbd>Enter</kbd> skips,{' '}
            <kbd>Esc</kbd> clears. Nothing is added to the post until you approve it.
          </p>
        )}
        {editable && mentions.length > 0 && (
          <button
            type="button"
            className="btn btn--small"
            disabled={pending.length === 0}
            onClick={onSkipRemaining}
          >
            Skip all remaining ({pending.length})
          </button>
        )}
      </header>

      {mentions.length === 0 ? (
        <p className="detail__empty">No product mentions were found in this post.</p>
      ) : (
        <div className="aff__body">
          <MarkContext.Provider
            value={{
              byId: new Map(live.map((m) => [m.id, m])),
              activeId,
              onActivateMention: (id) => {
                setActiveId(id);
                inputs.current.get(id)?.focus();
              },
            }}
          >
            <div className="markdown aff__article">
              {renderArticle(affiliatePlugin(live), components)}
            </div>
          </MarkContext.Provider>
          <ol className="aff__list">
            {mentions.map((m) => (
              <AffiliateRow
                key={m.id}
                mention={m}
                editable={editable}
                stale={stale.has(m.id)}
                active={activeId === m.id}
                onSave={onSave}
                onSkip={onSkip}
                onReset={onReset}
                onAdvance={advance}
                onActivate={activate}
                registerInput={(id, el) => {
                  if (el) {
                    inputs.current.set(id, el);
                  } else {
                    inputs.current.delete(id);
                  }
                }}
              />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
