import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { AffiliateStep, affiliatePlugin, staleAffiliates } from './AffiliateStep';
import type { AffiliateStepProps } from './AffiliateStep';
import type { AffiliateMention } from '../api/post-detail';

const URL_OK = 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-bconn66-21';

const ARTICLE = [
  'I printed the lid on the Mars 5 Ultra and it came out well.',
  '',
  'Later the Mars 5 Ultra jammed, so I fitted a magnetic flex plate before the next job.',
  '',
  'The **Creality CR6-SE** is loud.',
].join('\n');

const mention = (id: string, anchor: string, before: string, after: string, over: Partial<AffiliateMention> = {}): AffiliateMention => ({
  id,
  kind: 'affiliate',
  anchorText: anchor,
  productName: `${anchor} product`,
  quote: `${before}${anchor}${after}`,
  before,
  after,
  occurrence: { paragraph: 0, offset: 0 },
  reason: `Reason ${id}`,
  decision: 'pending',
  ...over,
});

const MARS = mention('m1', 'Mars 5 Ultra', 'I printed the lid on the ', ' and it came out well.');
const PLATE = mention('m2', 'magnetic flex plate', 'so I fitted a ', ' before the next job.');
// In the source the anchor sits inside bold, so its surrounding text spans several nodes.
const SPLIT = mention('m3', 'Creality CR6-SE', 'The **', '** is loud.');

function setup(mentions = [MARS, PLATE], over: Partial<AffiliateStepProps> = {}) {
  const props: AffiliateStepProps = {
    mentions,
    markdown: ARTICLE,
    editable: true,
    sourceTrackingId: 'nakomis-bconn66-21',
    typedTrackingId: undefined,
    renderArticle: (plugin: ReturnType<typeof affiliatePlugin>, components: Components) => (
      <Markdown remarkPlugins={[plugin]} components={components}>
        {ARTICLE}
      </Markdown>
    ),
    onSave: vi.fn().mockResolvedValue({ ok: true, warnings: [] }),
    onSkip: vi.fn(),
    onReset: vi.fn(),
    onSkipRemaining: vi.fn().mockResolvedValue(true),
    onAllDecided: vi.fn(),
    onSetTrackingId: vi.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
  const view = render(<AffiliateStep {...props} />);
  return { props, view };
}

describe('affiliatePlugin and staleAffiliates', () => {
  test('staleAffiliates flags mentions whose surrounding text is not found exactly once', () => {
    const gone = mention('g', 'Mars 5 Ultra', 'on a ', ' today');
    const twice = mention('t', 'Mars', '', ' ');
    expect(staleAffiliates([MARS, PLATE, gone, twice], ARTICLE).map((m) => m.id)).toEqual(['g', 't']);
  });
});

describe('AffiliateStep', () => {
  test('highlights each mention at its own sentence, not at the other occurrences', () => {
    setup();
    const marks = document.querySelectorAll('mark[data-affiliate-id]');
    expect(Array.from(marks).map((m) => m.getAttribute('data-affiliate-id'))).toEqual(['m1', 'm2']);
    expect(marks[0].textContent).toBe('Mars 5 Ultra');
    // The second "Mars 5 Ultra" (in the jam sentence) is plain text.
    expect(document.querySelectorAll('mark').length).toBe(2);
    expect(marks[0].closest('p')?.textContent).toContain('printed the lid');
  });

  test('a mention whose surroundings are split by emphasis is still highlighted, by its anchor alone', () => {
    setup([MARS, SPLIT]);
    const marks = document.querySelectorAll('mark[data-affiliate-id]');
    expect(Array.from(marks).map((m) => m.getAttribute('data-affiliate-id'))).toEqual(['m1', 'm3']);
    expect(marks[1].textContent).toBe('Creality CR6-SE');
    expect(marks[1].closest('strong')).not.toBeNull();
    expect(screen.getAllByLabelText(/SiteStripe link for/)).toHaveLength(2);
  });

  test('the fallback stays inside the right paragraph and highlights once', () => {
    // "Mars 5 Ultra" appears in two paragraphs; the second mention's locator only fits the second.
    const md = 'First **Mars 5 Ultra** here.\n\nSecond the **Mars 5 Ultra** there.';
    const first = mention('f', 'Mars 5 Ultra', 'First **', '** here.');
    const second = mention('s', 'Mars 5 Ultra', 'Second the **', '** there.');
    render(
      <Markdown remarkPlugins={[affiliatePlugin([second, first])]}>{md}</Markdown>,
    );
    const marks = document.querySelectorAll('mark');
    expect(marks).toHaveLength(2);
    expect(marks[0].closest('p')?.textContent).toContain('First');
    expect(marks[1].closest('p')?.textContent).toContain('Second');
  });

  test('the fallback does not highlight when the paragraph text does not fit', () => {
    const lost = mention('x', 'Creality CR6-SE', 'Wrong **', '** words');
    render(<Markdown remarkPlugins={[affiliatePlugin([lost])]}>{ARTICLE}</Markdown>);
    expect(document.querySelectorAll('mark')).toHaveLength(0);
  });

  test('lists a row per mention in order and focuses the first undecided box', () => {
    setup();
    const boxes = screen.getAllByLabelText(/SiteStripe link for/);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toHaveFocus();
  });

  test('Enter saves and moves focus to the next undecided mention', async () => {
    const { props } = setup();
    const [first, second] = screen.getAllByLabelText(/SiteStripe link for/);
    fireEvent.change(first, { target: { value: URL_OK } });
    fireEvent.keyDown(first, { key: 'Enter' });
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith('m1', URL_OK));
    await waitFor(() => expect(second).toHaveFocus());
  });

  test('Shift+Enter skips and moves on', () => {
    const { props } = setup();
    const [first, second] = screen.getAllByLabelText(/SiteStripe link for/);
    fireEvent.keyDown(first, { key: 'Enter', shiftKey: true });
    expect(props.onSkip).toHaveBeenCalledWith('m1');
    expect(second).toHaveFocus();
  });

  test('focusing a row makes its mention the active one, and focusing a mention focuses its row', () => {
    setup();
    const [, second] = screen.getAllByLabelText(/SiteStripe link for/);
    fireEvent.focus(second);
    expect(document.querySelector('mark[data-affiliate-id="m2"]')).toHaveClass('aff-mark--active');
    expect(document.querySelector('mark[data-affiliate-id="m1"]')).not.toHaveClass('aff-mark--active');
    fireEvent.focus(document.querySelector('mark[data-affiliate-id="m1"]') as Element);
    expect(screen.getAllByLabelText(/SiteStripe link for/)[0]).toHaveFocus();
  });

  test('marks reflect decisions', () => {
    setup([
      { ...MARS, decision: 'linked', url: URL_OK },
      { ...PLATE, decision: 'skipped' },
    ]);
    expect(document.querySelector('mark[data-affiliate-id="m1"]')).toHaveClass('aff-mark--linked');
    expect(document.querySelector('mark[data-affiliate-id="m2"]')).toHaveClass('aff-mark--skipped');
  });

  test('Skip all remaining skips only what is pending, and is disabled when nothing is', async () => {
    const { props, view } = setup([MARS, { ...PLATE, decision: 'skipped' }]);
    fireEvent.click(screen.getByRole('button', { name: /Skip all remaining \(1\)/ }));
    expect(props.onSkipRemaining).toHaveBeenCalled();
    await waitFor(() => expect(props.onAllDecided).toHaveBeenCalled());
    view.rerender(<AffiliateStep {...props} mentions={[{ ...MARS, decision: 'linked', url: URL_OK }]} />);
    expect(screen.getByRole('button', { name: /Skip all remaining \(0\)/ })).toBeDisabled();
  });

  test('stale mentions are marked and cannot take a link', () => {
    setup([MARS, mention('g', 'Mars 5 Ultra', 'on a ', ' today')]);
    expect(screen.getAllByLabelText(/SiteStripe link for/)).toHaveLength(1);
    expect(screen.getByText(/text around this mention has changed/)).toBeInTheDocument();
  });

  test('read-only when not staged', () => {
    setup([MARS], { editable: false });
    expect(screen.queryByLabelText(/SiteStripe link for/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Skip all remaining/ })).not.toBeInTheDocument();
  });

  test('says there is nothing to do when there are no mentions', () => {
    setup([]);
    expect(screen.getByText(/No product mentions/)).toBeInTheDocument();
  });
});

describe('AffiliateStep tracking id', () => {
  test('shows the source file id and offers no box', () => {
    setup();
    expect(screen.getByText('nakomis-bconn66-21')).toBeInTheDocument();
    expect(screen.queryByLabelText('Per-post tracking ID')).not.toBeInTheDocument();
  });

  test('warns when there is none, and lets you type one', async () => {
    const { props } = setup([MARS], { sourceTrackingId: undefined });
    const warn = screen.getByRole('status');
    expect(within(warn).getByText(/no amazon_tracking_id/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Per-post tracking ID'), { target: { value: 'nakomis-bconn66-21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this ID' }));
    await waitFor(() => expect(props.onSetTrackingId).toHaveBeenCalledWith('nakomis-bconn66-21'));
  });

  test('shows why a tracking id was refused', async () => {
    setup([MARS], {
      sourceTrackingId: undefined,
      onSetTrackingId: vi.fn().mockResolvedValue({ ok: false, error: 'Not a per-post id.' }),
    });
    fireEvent.change(screen.getByLabelText('Per-post tracking ID'), { target: { value: 'nakomis-21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this ID' }));
    expect(await screen.findByText('Not a per-post id.')).toBeInTheDocument();
  });

  test('a typed id is shown and can be cleared', async () => {
    const { props } = setup([MARS], { sourceTrackingId: undefined, typedTrackingId: 'nakomis-bconn66-21' });
    expect(screen.getByText('nakomis-bconn66-21')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(props.onSetTrackingId).toHaveBeenCalledWith(null));
  });
});

describe('affiliatePlugin', () => {
  test('is a remark plugin that leaves text alone when nothing matches', () => {
    render(
      <Markdown remarkPlugins={[affiliatePlugin([mention('x', 'Nothing', 'no ', ' here')])]}>
        {ARTICLE}
      </Markdown>,
    );
    expect(document.querySelectorAll('mark').length).toBe(0);
  });
});

describe('AffiliateStep focus when everything is decided', () => {
  test('saving the last pending mention hands focus on', async () => {
    const { props } = setup([MARS, { ...PLATE, decision: 'skipped' }]);
    const [only] = screen.getAllByLabelText(/SiteStripe link for/);
    fireEvent.change(only, { target: { value: URL_OK } });
    fireEvent.keyDown(only, { key: 'Enter' });
    await waitFor(() => expect(props.onAllDecided).toHaveBeenCalled());
  });

  test('skipping the last pending mention hands focus on', () => {
    const { props } = setup([MARS]);
    fireEvent.keyDown(screen.getByLabelText(/SiteStripe link for/), { key: 'Enter', shiftKey: true });
    expect(props.onAllDecided).toHaveBeenCalled();
  });

  test('not while another mention still needs a link', async () => {
    const { props } = setup();
    fireEvent.change(screen.getAllByLabelText(/SiteStripe link for/)[0], { target: { value: URL_OK } });
    fireEvent.keyDown(screen.getAllByLabelText(/SiteStripe link for/)[0], { key: 'Enter' });
    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(props.onAllDecided).not.toHaveBeenCalled();
  });

  test('a failed Skip all remaining does not move focus', async () => {
    const { props } = setup([MARS], { onSkipRemaining: vi.fn().mockResolvedValue(false) });
    fireEvent.click(screen.getByRole('button', { name: /Skip all remaining/ }));
    await waitFor(() => expect(props.onSkipRemaining).toHaveBeenCalled());
    expect(props.onAllDecided).not.toHaveBeenCalled();
  });
});
