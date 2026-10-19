import {
  affiliateId,
  amazonLinkTexts,
  asinOf,
  isValidTrackingId,
  validateAffiliateUrl,
  validateProducts,
} from '../../../lambda/suggest/affiliate';
import type { ProductPick } from '../../../lambda/suggest/schema';

const GOOD = 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-bconn66-21';

const check = (raw: string, ctx = {}) =>
  validateAffiliateUrl(raw, { effectiveTrackingId: 'nakomis-bconn66-21', otherAsins: [], ...ctx });

describe('validateAffiliateUrl', () => {
  test('accepts a SiteStripe full link and returns it byte for byte', () => {
    const r = check(GOOD);
    expect(r).toEqual({ ok: true, url: GOOD, tag: 'nakomis-bconn66-21', asin: 'B0F4D8ZY6L', warnings: [] });
  });

  test('trims surrounding whitespace only', () => {
    const r = check(`  ${GOOD}\n`);
    expect(r.ok && r.url).toBe(GOOD);
  });

  test.each([
    ['https://amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21'],
    ['https://www.amazon.co.uk/Some-Title/dp/B0F4D8ZY6L/ref=sr_1_1?tag=nakomis-21&th=1'],
  ])('accepts amazon.co.uk with or without www: %s', (url) => {
    expect(check(url).ok).toBe(true);
  });

  test.each([
    ['', 'empty'],
    ['not a url', 'not a URL'],
    ['http://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21', 'https'],
    ['https://user:pw@www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21', 'sign-in details'],
    ['https://www.amazon.co.uk:8443/dp/B0F4D8ZY6L?tag=nakomis-21', 'port'],
    ['https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21 and more', 'whitespace'],
    ['https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21)x', 'brackets'],
    ['https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21"', 'brackets'],
    [`https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21&x=${'a'.repeat(2100)}`, 'long'],
  ])('rejects %s', (raw, fragment) => {
    const r = check(raw);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error.toLowerCase()).toContain(fragment.toLowerCase());
  });

  test.each([
    ['an explicit default port', 'https://www.amazon.co.uk:443/dp/B0F4D8ZY6L?tag=nakomis-21'],
    ['an empty userinfo', 'https://@www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21'],
    ['an upper-case scheme', 'HTTPS://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21'],
    ['an upper-case host', 'https://WWW.AMAZON.CO.UK/dp/B0F4D8ZY6L?tag=nakomis-21'],
    ['a full-width host', 'https://ｗｗｗ.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21'],
    ['a full-width dot in the host', 'https://www.amazon。co.uk/dp/B0F4D8ZY6L?tag=nakomis-21'],
    ['an IDN look-alike host', 'https://www.amazοn.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21'],
    ['a backslash after the host', 'https://www.amazon.co.uk\\dp/B0F4D8ZY6L?tag=nakomis-21'],
    ['a backslash in the path', 'https://www.amazon.co.uk/dp\\B0F4D8ZY6L?tag=nakomis-21'],
    ['a single quote', "https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21'"],
    ['a square bracket', 'https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21[1]'],
    ['a non-ASCII character in the path', 'https://www.amazon.co.uk/dp/B0F4D8ZYé?tag=nakomis-21'],
    ['no path at all', 'https://www.amazon.co.uk?tag=nakomis-21'],
  ])('rejects %s, which new URL() would quietly tidy', (_name, raw) => {
    expect(check(raw).ok).toBe(false);
  });

  test('says what is wrong with a trailing-dot host, rather than that it is not amazon.co.uk', () => {
    const r = check('https://www.amazon.co.uk./dp/B0F4D8ZY6L?tag=nakomis-21');
    expect(r.ok === false && r.error).toContain('ends with a dot');
  });

  test('explains a link that is only odd in the raw text', () => {
    const r = check('HTTPS://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21');
    expect(r.ok === false && r.error).toContain('plain form');
  });

  test.each(['amzn.to/3abc', 'link.amazon/abc', 'amzn.eu/d/abc', 'a.co/d/abc'])(
    'rejects the short link %s and asks for the Full link',
    (host) => {
      const r = check(`https://${host}`);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error).toContain("SiteStripe's Full link");
    },
  );

  test.each([
    'https://www.amazon.com/dp/B0F4D8ZY6L?tag=nakomis-21',
    'https://www.amazon.de/dp/B0F4D8ZY6L?tag=nakomis-21',
  ])('rejects another Amazon marketplace: %s', (url) => {
    const r = check(url);
    expect(r.ok === false && r.error).toContain('earns nothing');
  });

  test.each([
    'https://amazon.co.uk.evil.com/dp/B0F4D8ZY6L?tag=nakomis-21',
    'https://evilamazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21',
    'https://smile.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21',
    'https://example.com/?tag=nakomis-21',
  ])('rejects a host that is not amazon.co.uk: %s', (url) => {
    expect(check(url).ok).toBe(false);
  });

  test('rejects a link with no tag', () => {
    const r = check('https://www.amazon.co.uk/dp/B0F4D8ZY6L');
    expect(r.ok === false && r.error).toContain('no tag');
  });

  test('rejects two tags', () => {
    expect(check('https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21&tag=nakomis-x-21').ok).toBe(false);
  });

  test.each(['someoneelse-21', 'nakomis-22', 'nakomis', 'nakomis--21', 'Nakomis-21', 'nakomis-x-21-21x', ''])(
    'rejects the tag %p',
    (tag) => {
      expect(check(`https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=${tag}`).ok).toBe(false);
    },
  );

  test.each(['nakomis-21', 'nakomis-bconn66-21', 'nakomis-esp32-s3-21'])('accepts the tag %s', (tag) => {
    expect(check(`https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=${tag}`, { effectiveTrackingId: tag }).ok).toBe(true);
  });

  test('warns, without rejecting, when the tag differs from the post tracking id', () => {
    const r = check('https://www.amazon.co.uk/dp/B0F4D8ZY6L?tag=nakomis-21');
    expect(r.ok && r.warnings.join(' ')).toMatch(/tag is nakomis-21 but this post uses nakomis-bconn66-21/);
  });

  test('warns when the post has no tracking id', () => {
    const r = check(GOOD, { effectiveTrackingId: undefined });
    expect(r.ok && r.warnings.join(' ')).toMatch(/No amazon_tracking_id/);
  });

  test('warns when the page has no ASIN', () => {
    const r = check('https://www.amazon.co.uk/s?k=flex+plate&tag=nakomis-bconn66-21');
    expect(r.ok && r.warnings.join(' ')).toMatch(/Not a product page/);
  });

  test('warns when the product is already attached to another mention', () => {
    const r = check(GOOD, { otherAsins: ['B0F4D8ZY6L'] });
    expect(r.ok && r.warnings.join(' ')).toMatch(/Only the first will be linked/);
  });
});

describe('asinOf and isValidTrackingId', () => {
  test('extracts ASINs from the common path shapes', () => {
    expect(asinOf('/Title/dp/b0f4d8zy6l/ref=x')).toBe('B0F4D8ZY6L');
    expect(asinOf('/gp/product/B0CRK47HXM')).toBe('B0CRK47HXM');
    expect(asinOf('/s')).toBeUndefined();
  });

  test('tracking ids must be per-post, not the bare store id', () => {
    expect(isValidTrackingId('nakomis-bconn66-21')).toBe(true);
    expect(isValidTrackingId('nakomis-21')).toBe(false);
    expect(isValidTrackingId('other-x-21')).toBe(false);
    expect(isValidTrackingId('nakomis-x-22')).toBe(false);
  });
});

describe('amazonLinkTexts', () => {
  test('returns the text of Amazon links only', () => {
    const body = '[Mars 5](https://www.amazon.co.uk/dp/B0AAAAAAAA) and [repo](https://github.com/x/y) and [a](https://amzn.to/x).';
    expect(amazonLinkTexts(body)).toEqual(['Mars 5', 'a']);
  });
});

const BODY = `# Printing

I printed the lid on the Creality CR6-SE and it came out well.

The Creality CR6-SE needed a new bed, so I fitted a magnetic flex plate before the next job.

Later the Creality CR6-SE jammed. I see [the Cabal](https://blog.nakomis.com/x) differently now.

\`\`\`
Creality CR6-SE
\`\`\`
`;

const prod = (over: Partial<ProductPick> = {}): ProductPick => ({
  anchor_text: 'Creality CR6-SE',
  quote: 'I printed the lid on the Creality CR6-SE and it came out well.',
  product_name: 'Creality CR6-SE printer',
  used_by_author: true,
  reason: 'He printed on it.',
  ...over,
});

const validate = (picks: ProductPick[], over = {}) =>
  validateProducts({ picks, body: BODY, linkRanges: [], existingAmazonTexts: [], maxMentions: 8, ...over });

describe('validateProducts', () => {
  test('accepts a product repeated in the body when its sentence is unique', () => {
    const { accepted, dropped } = validate([prod()]);
    expect(dropped).toEqual([]);
    expect(accepted).toHaveLength(1);
    const m = accepted[0];
    expect(m).toMatchObject({
      kind: 'affiliate',
      anchorText: 'Creality CR6-SE',
      productName: 'Creality CR6-SE printer',
      decision: 'pending',
    });
    expect(m.id).toBe(affiliateId('Creality CR6-SE'));
    expect(BODY.slice(m.occurrence.offset, m.occurrence.offset + 'Creality CR6-SE'.length)).toBe('Creality CR6-SE');
    // Located at the first sentence, not the later ones.
    expect(m.occurrence.offset).toBe(BODY.indexOf('I printed') + 'I printed the lid on the '.length);
    expect(m.before.endsWith('on the ')).toBe(true);
    expect(m.after.startsWith(' and it came')).toBe(true);
    expect(BODY.split(m.before + m.anchorText + m.after)).toHaveLength(2);
  });

  test('the locator is unique even when the anchor is not', () => {
    const { accepted } = validate([prod({ anchor_text: 'magnetic flex plate', quote: 'The Creality CR6-SE needed a new bed, so I fitted a magnetic flex plate before the next job.', product_name: 'Magnetic flex plate' })]);
    expect(accepted).toHaveLength(1);
  });

  test('drops used_by_author false', () => {
    const r = validate([prod({ used_by_author: false })]);
    expect(r.accepted).toEqual([]);
    expect(r.dropped[0].reason).toMatch(/did not use|not used/);
    expect(r.dropped[0].kind).toBe('affiliate');
  });

  test('drops a quote that is not in the post', () => {
    expect(validate([prod({ quote: 'Something never written.' })]).dropped[0].reason).toMatch(/sentence is not in the post/);
  });

  test('drops a quote that occurs twice', () => {
    const body = 'I love the Mars 5 Ultra. I love the Mars 5 Ultra. Fine.';
    const r = validateProducts({
      picks: [prod({ anchor_text: 'Mars 5 Ultra', quote: 'I love the Mars 5 Ultra.' })],
      body,
      linkRanges: [],
      existingAmazonTexts: [],
      maxMentions: 8,
    });
    expect(r.dropped[0].reason).toMatch(/more than once/);
  });

  test('drops an anchor that is not in its quote', () => {
    expect(validate([prod({ anchor_text: 'Mars 5 Ultra' })]).dropped[0].reason).toMatch(/not in the sentence/);
  });

  test('anchor length: one character is dropped for length, two are accepted', () => {
    const body = 'I use a Q daily. I also use a Q2 daily.';
    const run = (anchor: string, quote: string) =>
      validateProducts({
        picks: [prod({ anchor_text: anchor, quote, product_name: anchor })],
        body,
        linkRanges: [],
        existingAmazonTexts: [],
        maxMentions: 8,
      });
    const one = run('Q', 'I use a Q daily.');
    expect(one.accepted).toEqual([]);
    expect(one.dropped[0].reason).toMatch(/2 to 60 characters/);
    expect(run('Q2', 'I also use a Q2 daily.').accepted).toHaveLength(1);
  });

  test.each([
    ['a b c d e f g', 'too many words', /at most 6 words/],
    ['x'.repeat(61), 'too long', /2 to 60 characters/],
    ['[Creality]', 'brackets', /brackets/],
  ])('drops a bad anchor %s (%s)', (anchor, _why, reason) => {
    const r = validate([prod({ anchor_text: anchor })]);
    expect(r.accepted).toEqual([]);
    expect(r.dropped[0].reason).toMatch(reason);
  });

  test('drops an anchor inside a link, heading, code or shortcode', () => {
    const body = [
      '# The Mars 5 Ultra review',
      '',
      'See [the Mars 5 Ultra](https://example.com) here.',
      '',
      'Use `Mars 5 Ultra` as the name.',
      '',
      '{{image: the Mars 5 Ultra on a desk}}',
      '',
    ].join('\n');
    for (const quote of [
      '# The Mars 5 Ultra review',
      'See [the Mars 5 Ultra](https://example.com) here.',
      'Use `Mars 5 Ultra` as the name.',
      '{{image: the Mars 5 Ultra on a desk}}',
    ]) {
      const r = validateProducts({
        picks: [prod({ anchor_text: 'Mars 5 Ultra', quote })],
        body,
        linkRanges: [],
        existingAmazonTexts: [],
        maxMentions: 8,
      });
      expect(r.accepted).toEqual([]);
      expect(r.dropped[0].reason).toMatch(/heading, code, link, image or shortcode/);
    }
  });

  test('drops an anchor that starts or ends mid-word', () => {
    const body = 'The Mars 5 Ultrasonic cleaner was loud.';
    const r = validateProducts({
      picks: [prod({ anchor_text: 'Mars 5 Ultra', quote: body })],
      body,
      linkRanges: [],
      existingAmazonTexts: [],
      maxMentions: 8,
    });
    expect(r.dropped[0].reason).toMatch(/middle of a word/);
  });

  test('drops an anchor overlapping a suggested link', () => {
    const start = BODY.indexOf('Creality CR6-SE');
    const r = validate([prod()], { linkRanges: [[start - 2, start + 5]] });
    expect(r.dropped[0].reason).toMatch(/overlaps a suggested link/);
  });

  test('drops an anchor equal to the text of an existing Amazon link', () => {
    const r = validate([prod()], { existingAmazonTexts: ['creality cr6-se'] });
    expect(r.dropped[0].reason).toMatch(/already linked to Amazon/);
  });

  test('one mention per product', () => {
    const r = validate([
      prod(),
      prod({
        anchor_text: 'CR6-SE',
        quote: 'Later the Creality CR6-SE jammed.',
        product_name: 'creality cr6-se printer',
      }),
    ]);
    expect(r.accepted).toHaveLength(1);
    expect(r.dropped[0].reason).toMatch(/already offered/);
  });

  test('applies the cap in document order', () => {
    const body = 'I bought an Alpha 1. I bought a Beta 2. I bought a Gamma 3.';
    const picks = ['Gamma 3', 'Alpha 1', 'Beta 2'].map((a) =>
      prod({ anchor_text: a, quote: `I bought ${a.startsWith('A') ? 'an' : 'a'} ${a}.`, product_name: a }),
    );
    const r = validateProducts({ picks, body, linkRanges: [], existingAmazonTexts: [], maxMentions: 2 });
    expect(r.accepted.map((m) => m.anchorText)).toEqual(['Alpha 1', 'Beta 2']);
    expect(r.dropped[0].reason).toMatch(/more than 2/);
  });
});
