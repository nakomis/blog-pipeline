import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { AffiliateMention } from '../api/post-detail';

/**
 * One product mention in the affiliate step (PIPE-41): a box to paste the
 * SiteStripe link, Skip, and what happened to it. Built for speed from the
 * keyboard: paste, Enter saves and moves to the next undecided mention;
 * Shift+Enter skips; Escape clears. The link is validated by the server and kept
 * exactly as pasted.
 */

export interface SaveResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
}

export function AffiliateRow({
  mention,
  editable,
  stale,
  active,
  onSave,
  onSkip,
  onReset,
  onAdvance,
  onActivate,
  registerInput,
}: {
  mention: AffiliateMention;
  editable: boolean;
  /** The text around the anchor has changed since the mention was found. */
  stale: boolean;
  /** This mention is the one being worked on (highlighted in the article). */
  active: boolean;
  onSave: (id: string, url: string) => Promise<SaveResult>;
  onSkip: (id: string) => void;
  onReset: (id: string) => void;
  /** Move focus to the next undecided mention. */
  onAdvance: (id: string) => void;
  onActivate: (id: string) => void;
  registerInput: (id: string, el: HTMLInputElement | null) => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = `aff-err-${mention.id}`;

  const save = async () => {
    if (value.trim() === '' || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await onSave(mention.id, value);
      if (result.ok) {
        setValue('');
        onAdvance(mention.id);
      } else {
        setError(result.error ?? 'That link was not accepted.');
      }
    } catch (err) {
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const skip = () => {
    onSkip(mention.id);
    onAdvance(mention.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        skip();
      } else {
        void save();
      }
    } else if (e.key === 'Escape') {
      setValue('');
      setError(null);
    }
  };

  const state =
    mention.decision === 'linked'
      ? 'Linked'
      : mention.decision === 'skipped'
        ? 'Skipped'
        : stale
          ? 'Text changed'
          : 'Affiliate link needed';

  return (
    <li
      className={`aff-row aff-row--${mention.decision}${active ? ' aff-row--active' : ''}${stale ? ' aff-row--stale' : ''}`}
      data-affiliate-row={mention.id}
    >
      <div className="aff-row__head">
        <strong>{mention.productName}</strong>
        <span className={`badge aff-row__state aff-row__state--${mention.decision}`}>{state}</span>
      </div>
      <p className="aff-row__quote">
        {renderQuote(mention)}
      </p>
      <p className="aff-row__reason">{mention.reason}</p>

      {mention.decision === 'linked' && mention.url && (
        <div className="aff-row__linked">
          <a href={mention.url} target="_blank" rel="noopener noreferrer">
            {mention.url}
          </a>
          {mention.warnings && mention.warnings.length > 0 && (
            <ul className="aff-row__warnings">
              {mention.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {stale && mention.decision === 'pending' && (
        <p className="aff-row__stale">
          The text around this mention has changed, so it cannot be linked and will be skipped on
          approval.
        </p>
      )}

      {editable && mention.decision === 'pending' && !stale && (
        <div className="aff-row__form">
          <label>
            <span className="aff-row__label">SiteStripe link for “{mention.anchorText}”</span>
            <input
              ref={(el) => registerInput(mention.id, el)}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              value={value}
              disabled={busy}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? errorId : undefined}
              aria-keyshortcuts="Enter Shift+Enter Escape"
              placeholder="Paste the full amazon.co.uk link from SiteStripe"
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              onKeyDown={onKeyDown}
              onFocus={() => onActivate(mention.id)}
            />
          </label>
          <button type="button" className="btn btn--small btn--primary" disabled={busy} onClick={() => void save()}>
            Save
          </button>
          <button type="button" className="btn btn--small" disabled={busy} onClick={skip}>
            Skip
          </button>
          {error && (
            <p id={errorId} className="aff-row__error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}

      {editable && mention.decision === 'pending' && stale && (
        <div className="aff-row__form">
          <button type="button" className="btn btn--small" onClick={skip}>
            Skip
          </button>
        </div>
      )}

      {editable && mention.decision !== 'pending' && (
        <div className="aff-row__form">
          <button type="button" className="btn btn--small" onClick={() => onReset(mention.id)}>
            Undo
          </button>
        </div>
      )}
    </li>
  );
}

/** The sentence with the anchor in bold. */
function renderQuote(m: AffiliateMention) {
  const at = m.quote.indexOf(m.anchorText);
  if (at === -1) {
    return m.quote;
  }
  return (
    <>
      {m.quote.slice(0, at)}
      <strong>{m.anchorText}</strong>
      {m.quote.slice(at + m.anchorText.length)}
    </>
  );
}
