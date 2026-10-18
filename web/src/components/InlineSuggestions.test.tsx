import { fireEvent, render, screen } from '@testing-library/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LinkSuggestion } from '../api/post-detail';
import {
  SuggestionMark,
  SuggestionProvider,
  staleLinks,
  suggestionPlugin,
} from './InlineSuggestions';

function link(over: Partial<LinkSuggestion> = {}): LinkSuggestion {
  return {
    id: 'l1',
    kind: 'link',
    anchorText: 'the Cabal',
    context: '',
    targetSlug: '2026-07-29-cabal',
    targetTitle: 'Three of Seven AIs',
    targetUrl: 'https://blog.nakomis.com/2026-07-29-cabal',
    targetDate: '2026-07-29',
    occurrence: { paragraph: 0, offset: 0 },
    reason: 'It refers to the panel review.',
    decision: 'pending',
    ...over,
  };
}

function renderArticle(
  markdown: string,
  links: LinkSuggestion[],
  onDecide = vi.fn(),
  editable = true,
) {
  render(
    <SuggestionProvider links={links} onDecide={onDecide} editable={editable}>
      <Markdown
        remarkPlugins={[remarkGfm, suggestionPlugin(links)]}
        components={{ mark: (props) => <SuggestionMark {...props} /> }}
      >
        {markdown}
      </Markdown>
    </SuggestionProvider>,
  );
  return onDecide;
}

describe('inline highlighting', () => {
  test('highlights the anchor in prose, with Haiku’s reason in the popover', () => {
    renderArticle('I asked the Cabal what it thought.', [link()]);
    const mark = screen.getByText('the Cabal');
    expect(mark.tagName).toBe('MARK');
    expect(mark).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('group', { name: /link suggestion/i })).toHaveTextContent('It refers to the panel review.');
    expect(screen.getByRole('group', { name: /link suggestion/i })).toHaveTextContent('Three of Seven AIs');
    expect(mark).toHaveAttribute('aria-describedby', screen.getByRole('group', { name: /link suggestion/i }).id);
  });

  test('the popover is a labelled group, not a tooltip, since it holds buttons', () => {
    renderArticle('I asked the Cabal.', [link()]);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.getByRole('group', { name: 'Link suggestion' })).toContainElement(
      screen.getByRole('button', { name: 'Accept' }),
    );
  });

  test('Escape closes the popover, returns focus to the text, and hover reopens it', () => {
    renderArticle('I asked the Cabal.', [link()]);
    const mark = screen.getByText('the Cabal');
    const wrapper = mark.closest('.sugg') as HTMLElement;
    screen.getByRole('button', { name: 'Accept' }).focus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Accept' }), { key: 'Escape' });
    expect(wrapper).toHaveClass('sugg--dismissed');
    expect(mark).toHaveFocus();
    fireEvent.mouseEnter(wrapper);
    expect(wrapper).not.toHaveClass('sugg--dismissed');
  });

  test('other keys leave the popover open', () => {
    renderArticle('I asked the Cabal.', [link()]);
    const wrapper = screen.getByText('the Cabal').closest('.sugg') as HTMLElement;
    fireEvent.keyDown(wrapper, { key: 'Tab' });
    expect(wrapper).not.toHaveClass('sugg--dismissed');
  });

  test('accept and reject report the choice', () => {
    const onDecide = renderArticle('I asked the Cabal.', [link()]);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDecide).toHaveBeenNthCalledWith(1, 'l1', 'accepted');
    expect(onDecide).toHaveBeenNthCalledWith(2, 'l1', 'rejected');
  });

  test('an accepted link renders as a link marked "applied on approval", with undo', () => {
    const onDecide = renderArticle('I asked the Cabal.', [link({ decision: 'accepted' })]);
    const anchor = screen.getByRole('link', { name: 'the Cabal' });
    expect(anchor).toHaveAttribute('href', 'https://blog.nakomis.com/2026-07-29-cabal');
    expect(anchor).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('group', { name: /link suggestion/i })).toHaveTextContent('Link applied on approval');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onDecide).toHaveBeenCalledWith('l1', 'pending');
  });

  test('a rejected suggestion loses its highlight', () => {
    renderArticle('I asked the Cabal.', [link({ decision: 'rejected' })]);
    expect(screen.queryByRole('group', { name: /link suggestion/i })).toBeNull();
    expect(screen.getByText(/I asked the Cabal/)).toBeInTheDocument();
  });

  test('read-only when the post is no longer staged', () => {
    renderArticle('I asked the Cabal.', [link()], vi.fn(), false);
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.getByRole('group', { name: /link suggestion/i })).toBeInTheDocument();
  });

  test.each([
    ['a heading', '# The Cabal rises\n\nBody.'],
    ['inline code', 'Use `the Cabal` here.'],
    ['an existing link', 'See [the Cabal](https://x.test).'],
    ['a code block', '```\nthe Cabal\n```'],
  ])('never highlights inside %s', (_name, md) => {
    renderArticle(md, [link({ anchorText: md.includes('rises') ? 'The Cabal' : 'the Cabal' })]);
    expect(screen.queryByRole('group', { name: /link suggestion/i })).toBeNull();
  });

  test('highlights several anchors in one paragraph and keeps the text between', () => {
    renderArticle('First the Cabal then the panel today.', [
      link(),
      link({ id: 'l2', anchorText: 'the panel', targetTitle: 'Other' }),
    ]);
    expect(screen.getAllByRole('group', { name: /link suggestion/i })).toHaveLength(2);
    expect(screen.getByText(/then/)).toBeInTheDocument();
  });

  test('ignores an anchor that overlaps an earlier highlight', () => {
    renderArticle('about the Cabal panel today', [
      link({ anchorText: 'the Cabal panel' }),
      link({ id: 'l2', anchorText: 'Cabal panel' }),
    ]);
    expect(screen.getAllByRole('group', { name: /link suggestion/i })).toHaveLength(1);
  });

  test('a mark with no matching suggestion renders as plain text', () => {
    render(<SuggestionMark data-suggestion-id="nope">plain</SuggestionMark>);
    expect(screen.getByText('plain')).toBeInTheDocument();
    render(
      <SuggestionProvider links={[]} onDecide={vi.fn()} editable>
        <SuggestionMark data-suggestion-id="nope">orphan</SuggestionMark>
      </SuggestionProvider>,
    );
    expect(screen.getByText('orphan').tagName).not.toBe('MARK');
  });
});

describe('staleLinks', () => {
  test('flags anchors that are absent or no longer unique', () => {
    const links = [
      link(),
      link({ id: 'gone', anchorText: 'vanished' }),
      link({ id: 'twice', anchorText: 'echo' }),
    ];
    const stale = staleLinks(links, 'the Cabal and echo echo');
    expect(stale.map((l) => l.id)).toEqual(['gone', 'twice']);
  });
});
