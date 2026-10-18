import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AffiliateRow } from './AffiliateRow';
import type { AffiliateMention } from '../api/post-detail';

const URL_OK = 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-bconn66-21';

const mention = (over: Partial<AffiliateMention> = {}): AffiliateMention => ({
  id: 'm1',
  kind: 'affiliate',
  anchorText: 'Mars 5 Ultra',
  productName: 'Elegoo Mars 5 Ultra',
  quote: 'I printed on the Mars 5 Ultra today.',
  before: 'on the ',
  after: ' today.',
  occurrence: { paragraph: 0, offset: 0 },
  reason: 'He printed on it.',
  decision: 'pending',
  ...over,
});

function setup(m = mention(), over = {}) {
  const props = {
    mention: m,
    editable: true,
    stale: false,
    active: false,
    onSave: vi.fn().mockResolvedValue({ ok: true, warnings: [] }),
    onSkip: vi.fn(),
    onReset: vi.fn(),
    onAdvance: vi.fn(),
    onActivate: vi.fn(),
    registerInput: vi.fn(),
    ...over,
  };
  render(<ul><AffiliateRow {...props} /></ul>);
  return props;
}

const box = () => screen.getByLabelText(/SiteStripe link for/);

describe('AffiliateRow', () => {
  test('shows the product, the sentence, the reason and what is needed', () => {
    setup();
    expect(screen.getByText('Elegoo Mars 5 Ultra')).toBeInTheDocument();
    expect(screen.getByText(/I printed on the/)).toBeInTheDocument();
    expect(screen.getByText('He printed on it.')).toBeInTheDocument();
    expect(screen.getByText('Affiliate link needed')).toBeInTheDocument();
  });

  test('paste then Enter saves the link exactly as pasted and moves on', async () => {
    const p = setup();
    fireEvent.change(box(), { target: { value: URL_OK } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(p.onSave).toHaveBeenCalledWith('m1', URL_OK));
    await waitFor(() => expect(p.onAdvance).toHaveBeenCalledWith('m1'));
  });

  test('the Save button does the same', async () => {
    const p = setup();
    fireEvent.change(box(), { target: { value: URL_OK } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(p.onSave).toHaveBeenCalled());
  });

  test('Enter on an empty box does nothing', () => {
    const p = setup();
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(p.onSave).not.toHaveBeenCalled();
  });

  test('Shift+Enter skips and moves on', () => {
    const p = setup();
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(p.onSkip).toHaveBeenCalledWith('m1');
    expect(p.onAdvance).toHaveBeenCalledWith('m1');
  });

  test('the Skip button skips and moves on', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(p.onSkip).toHaveBeenCalledWith('m1');
    expect(p.onAdvance).toHaveBeenCalledWith('m1');
  });

  test('Escape clears the box', () => {
    setup();
    fireEvent.change(box(), { target: { value: 'junk' } });
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box()).toHaveValue('');
  });

  test('focus is still on the box after a refused link', async () => {
    setup(mention(), {
      onSave: vi.fn().mockResolvedValue({ ok: false, error: 'Nope.' }),
    });
    box().focus();
    fireEvent.change(box(), { target: { value: 'https://amzn.to/x' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText('Nope.');
    expect(document.activeElement).toBe(box());
  });

  test('the box stays focusable while saving (read-only, not disabled)', async () => {
    let finish: (r: { ok: boolean }) => void = () => undefined;
    setup(mention(), { onSave: vi.fn().mockReturnValue(new Promise((r) => { finish = r; })) });
    box().focus();
    fireEvent.change(box(), { target: { value: URL_OK } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(box()).toHaveAttribute('aria-busy', 'true'));
    expect(box()).toHaveAttribute('readonly');
    expect(box()).not.toBeDisabled();
    expect(document.activeElement).toBe(box());
    finish({ ok: false });
    await waitFor(() => expect(box()).not.toHaveAttribute('aria-busy'));
  });

  test('a network failure also leaves focus on the box', async () => {
    setup(mention(), { onSave: vi.fn().mockRejectedValue(new Error('offline')) });
    box().focus();
    fireEvent.change(box(), { target: { value: URL_OK } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText(/offline/);
    expect(document.activeElement).toBe(box());
  });

  test('warnings sit in a polite live region that is there before they arrive', () => {
    setup(mention({ decision: 'linked', url: URL_OK, warnings: ['Heads up.'] }));
    const live = screen.getByText('Heads up.').closest('[aria-live]');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  test('a rejected link keeps the text and focus, and says why', async () => {
    const p = setup(mention(), {
      onSave: vi.fn().mockResolvedValue({ ok: false, error: "Use SiteStripe's Full link." }),
    });
    fireEvent.change(box(), { target: { value: 'https://amzn.to/x' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByText("Use SiteStripe's Full link.")).toBeInTheDocument();
    expect(box()).toHaveValue('https://amzn.to/x');
    expect(box()).toHaveAttribute('aria-invalid', 'true');
    expect(p.onAdvance).not.toHaveBeenCalled();
  });

  test('a network failure is shown, not thrown', async () => {
    setup(mention(), { onSave: vi.fn().mockRejectedValue(new Error('offline')) });
    fireEvent.change(box(), { target: { value: URL_OK } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(await screen.findByText(/offline/)).toBeInTheDocument();
  });

  test('typing again clears the error', async () => {
    setup(mention(), { onSave: vi.fn().mockResolvedValue({ ok: false, error: 'Nope.' }) });
    fireEvent.change(box(), { target: { value: 'x' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText('Nope.');
    fireEvent.change(box(), { target: { value: 'xy' } });
    expect(screen.queryByText('Nope.')).not.toBeInTheDocument();
    expect(box()).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('a linked mention shows the link, its warnings, and Undo', () => {
    const p = setup(mention({ decision: 'linked', url: URL_OK, warnings: ['The tag is nakomis-21 but...'] }));
    expect(screen.getByText('Linked')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: URL_OK })).toHaveAttribute('href', URL_OK);
    expect(screen.getByText(/The tag is nakomis-21/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/SiteStripe link for/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(p.onReset).toHaveBeenCalledWith('m1');
  });

  test('a skipped mention can be undone', () => {
    const p = setup(mention({ decision: 'skipped' }));
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(p.onReset).toHaveBeenCalled();
  });

  test('a stale mention can only be skipped', () => {
    const p = setup(mention(), { stale: true });
    expect(screen.getByText(/text changed/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/SiteStripe link for/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(p.onSkip).toHaveBeenCalledWith('m1');
  });

  test('is read-only when the post is no longer staged', () => {
    setup(mention(), { editable: false });
    expect(screen.queryByLabelText(/SiteStripe link for/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
  });

  test('registers its input so focus can move to it, and activates on focus', () => {
    const p = setup();
    expect(p.registerInput).toHaveBeenCalledWith('m1', expect.any(HTMLInputElement));
    fireEvent.focus(box());
    expect(p.onActivate).toHaveBeenCalledWith('m1');
  });
});
