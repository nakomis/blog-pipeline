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
      readDraft: jest
        .fn()
        .mockResolvedValue({ body: '{{image prompt="one"}}', etag: '"v1"' }),
      writeDraft: jest.fn().mockResolvedValue(true),
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
      readDraft: jest.fn().mockResolvedValue({
        body: '{{image prompt="one"}}\n{{image prompt="two"}}',
        etag: '"v1"',
      }),
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
      '"v1"',
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

  test('retries on top of a draft that changed underneath it (approval applied links, PIPE-38)', async () => {
    const linked = 'See [the Cabal](https://blog.nakomis.com/x).\n{{image prompt="one"}}';
    const readDraft = jest
      .fn()
      .mockResolvedValueOnce({ body: 'See the Cabal.\n{{image prompt="one"}}', etag: '"v1"' })
      .mockResolvedValueOnce({ body: linked, etag: '"v2"' });
    // The first write loses the race: approval wrote the links in between.
    const writeDraft = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const d = deps({ readDraft, writeDraft });

    const result = await applyPlaceholders('post', d);

    expect(result.applied).toEqual([1]);
    expect(readDraft).toHaveBeenCalledTimes(2);
    expect(writeDraft).toHaveBeenNthCalledWith(
      1,
      'post/iteration-1/draft.md',
      'See the Cabal.\n![one](images/post-1.png)',
      '"v1"',
    );
    // The retry rewrote the image on top of the linked version, losing neither.
    expect(writeDraft).toHaveBeenNthCalledWith(
      2,
      'post/iteration-1/draft.md',
      'See [the Cabal](https://blog.nakomis.com/x).\n![one](images/post-1.png)',
      '"v2"',
    );
  });

  test('gives up with an error when the draft keeps changing', async () => {
    const d = deps({ writeDraft: jest.fn().mockResolvedValue(false) });
    await expect(applyPlaceholders('post', d)).rejects.toThrow('kept changing');
    expect(d.readDraft).toHaveBeenCalledTimes(3);
  });

  test('stops retrying once the other writer has already done the rewrite', async () => {
    const readDraft = jest
      .fn()
      .mockResolvedValueOnce({ body: '{{image prompt="one"}}', etag: '"v1"' })
      .mockResolvedValueOnce({ body: '![one](images/post-1.png)', etag: '"v2"' });
    const d = deps({ readDraft, writeDraft: jest.fn().mockResolvedValue(false) });
    const result = await applyPlaceholders('post', d);
    expect(result).toEqual({ applied: [], reason: 'nothing-to-do' });
  });
});
