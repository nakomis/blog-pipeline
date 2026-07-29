import {
  applyPlaceholders,
  parseImagePlaceholders,
  rewritePlaceholders,
  type ApplyPlaceholdersDeps,
} from '../../../lambda/images/placeholders';

describe('parseImagePlaceholders', () => {
  test('parses prompt and negative, single or double quoted', () => {
    const md =
      `intro\n{{image prompt="a black cat" negative='text, watermark'}}\nmore`;
    expect(parseImagePlaceholders(md, 'post')).toEqual([
      { index: 1, prompt: 'a black cat', negative: 'text, watermark' },
    ]);
  });

  test('numbers multiple placeholders in document order', () => {
    const md = `{{image prompt="one"}}\n{{image prompt="two"}}`;
    expect(parseImagePlaceholders(md, 'post')).toEqual([
      { index: 1, prompt: 'one', negative: undefined },
      { index: 2, prompt: 'two', negative: undefined },
    ]);
  });

  test('parses the model attribute when the tag names one (PIPE-27)', () => {
    const md = `{{image prompt="a labelled diagram" model="gpt-image-2"}}`;
    expect(parseImagePlaceholders(md, 'post')).toEqual([
      { index: 1, prompt: 'a labelled diagram', model: 'gpt-image-2' },
    ]);
  });

  test('returns nothing when there are no placeholders', () => {
    expect(parseImagePlaceholders('plain markdown', 'post')).toEqual([]);
  });

  test('keeps a placeholder on its original index past an already-generated link', () => {
    // Image 1 has already been rewritten; the remaining placeholder is still #2.
    const md = `![one](images/post-1.png)\n{{image prompt="two"}}`;
    expect(parseImagePlaceholders(md, 'post')).toEqual([
      { index: 2, prompt: 'two', negative: undefined },
    ]);
  });
});

describe('rewritePlaceholders', () => {
  test('rewrites only the available indices', () => {
    const md = `{{image prompt="one"}}\n{{image prompt="two"}}`;
    const out = rewritePlaceholders(md, 'post', new Set([1]));
    expect(out).toBe(`![one](images/post-1.png)\n{{image prompt="two"}}`);
  });

  test('is idempotent — a rewritten link is no longer a placeholder', () => {
    const md = `{{image prompt="one"}}`;
    const once = rewritePlaceholders(md, 'post', new Set([1]));
    const twice = rewritePlaceholders(once, 'post', new Set([1]));
    expect(twice).toBe(once);
  });

  test('preserves stable indexing across a second partial rewrite', () => {
    const md = `{{image prompt="one"}}\n{{image prompt="two"}}`;
    const first = rewritePlaceholders(md, 'post', new Set([2]));
    const second = rewritePlaceholders(first, 'post', new Set([1]));
    expect(second).toBe(
      `![one](images/post-1.png)\n![two](images/post-2.png)`,
    );
  });
});

describe('applyPlaceholders', () => {
  function deps(over: Partial<ApplyPlaceholdersDeps> = {}): ApplyPlaceholdersDeps {
    return {
      getPost: jest.fn().mockResolvedValue({
        status: 'staged',
        reviewIteration: 1,
      }),
      pngExists: jest.fn().mockResolvedValue(true),
      readDraft: jest.fn().mockResolvedValue('{{image prompt="one"}}'),
      writeDraft: jest.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  test('refuses to rewrite while the post is still reviewing', async () => {
    const d = deps({
      getPost: jest.fn().mockResolvedValue({ status: 'reviewing' }),
    });
    const result = await applyPlaceholders('post', d);
    expect(result).toEqual({ applied: [], reason: 'reviewing' });
    expect(d.readDraft).not.toHaveBeenCalled();
  });

  test('no-ops when there is no post item', async () => {
    const d = deps({ getPost: jest.fn().mockResolvedValue(undefined) });
    const result = await applyPlaceholders('post', d);
    expect(result).toEqual({ applied: [], reason: 'missing-post' });
  });

  test('rewrites placeholders whose PNG has arrived, in the final draft', async () => {
    const d = deps({
      readDraft: jest
        .fn()
        .mockResolvedValue('{{image prompt="one"}}\n{{image prompt="two"}}'),
      pngExists: jest
        .fn()
        .mockImplementation((_slug: string, index: number) =>
          Promise.resolve(index === 1),
        ),
    });

    const result = await applyPlaceholders('post', d);

    expect(result.applied).toEqual([1]);
    expect(d.readDraft).toHaveBeenCalledWith('post/iteration-1/draft.md');
    expect(d.writeDraft).toHaveBeenCalledWith(
      'post/iteration-1/draft.md',
      `![one](images/post-1.png)\n{{image prompt="two"}}`,
    );
  });

  test('writes nothing when no PNG has arrived yet', async () => {
    const d = deps({ pngExists: jest.fn().mockResolvedValue(false) });
    const result = await applyPlaceholders('post', d);
    expect(result).toEqual({ applied: [], reason: 'nothing-to-do' });
    expect(d.writeDraft).not.toHaveBeenCalled();
  });

  test('reads the draft for the post’s recorded iteration', async () => {
    const d = deps({
      getPost: jest
        .fn()
        .mockResolvedValue({ status: 'staged', reviewIteration: 3 }),
    });
    await applyPlaceholders('post', d);
    expect(d.readDraft).toHaveBeenCalledWith('post/iteration-3/draft.md');
  });
});
