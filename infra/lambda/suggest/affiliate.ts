import { createHash } from 'crypto';
import { AFFILIATE } from '../../lib/config';
import {
  crossesWordBoundary,
  occurrences,
  overlapsRange,
  paragraphIndex,
  protectedRanges,
} from './markdown';
import type { Range } from './markdown';
import type { AffiliateMention, DroppedSuggestion, ProductPick } from './schema';

/**
 * Affiliate product mentions (PIPE-41). All pure.
 *
 * The model only names a phrase and the sentence it sits in; it never writes a
 * URL or a tag. The link is pasted by the author and checked here. Nothing in
 * this file adds, removes or changes any part of a pasted link.
 */

const TAG_RE = new RegExp(AFFILIATE.tagPattern);
const TRACKING_ID_RE = new RegExp(AFFILIATE.trackingIdPattern);

/** Path shapes that carry an ASIN, as in the blog build (`amazonLinks.ts`). */
const ASIN_PATH_RES = [
  /\/dp\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/gp\/product\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/exec\/obidos\/ASIN\/([A-Z0-9]{10})(?:[/?#]|$)/i,
  /\/o\/ASIN\/([A-Z0-9]{10})(?:[/?#]|$)/i,
];

export function asinOf(pathname: string): string | undefined {
  for (const re of ASIN_PATH_RES) {
    const m = re.exec(pathname);
    if (m) {
      return m[1].toUpperCase();
    }
  }
  return undefined;
}

/** A per-post tracking id (`nakomis-<something>-21`); the bare store id is not one. */
export function isValidTrackingId(id: string): boolean {
  return TRACKING_ID_RE.test(id);
}

export function affiliateId(anchorText: string): string {
  return createHash('sha1')
    .update(['product', anchorText.toLowerCase()].join('\0'))
    .digest('hex')
    .slice(0, 12);
}

// ── Pasted links ────────────────────────────────────────────────────────────

export interface UrlContext {
  /** The post's `amazon_tracking_id`, or the one typed in the bag. */
  effectiveTrackingId?: string;
  /** ASINs already attached to other mentions. */
  otherAsins: string[];
}

export type UrlResult =
  | { ok: true; url: string; tag: string; asin?: string; warnings: string[] }
  | { ok: false; error: string };

const fail = (error: string): UrlResult => ({ ok: false, error });

/**
 * Check a pasted SiteStripe link. Returns the link exactly as pasted (trimmed)
 * or a reason. Needs no network.
 */
export function validateAffiliateUrl(raw: string, ctx: UrlContext): UrlResult {
  const text = raw.trim();
  if (text === '') {
    return fail('The box is empty: paste the SiteStripe link.');
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('That is not a URL: paste the SiteStripe link.');
  }
  if (text.length > AFFILIATE.maxUrlChars) {
    return fail(`That link is too long (over ${AFFILIATE.maxUrlChars} characters).`);
  }
  if (/\s/.test(text)) {
    return fail('The link contains whitespace: paste only the link.');
  }
  if (/[()<>"`]/.test(text)) {
    return fail('The link contains brackets or quotes, which would break the Markdown.');
  }
  if (url.protocol !== 'https:') {
    return fail('The link must start with https://.');
  }
  if (url.username || url.password) {
    return fail('The link contains sign-in details.');
  }
  if (url.port) {
    return fail('The link names a port.');
  }

  const host = url.hostname.toLowerCase();
  if ((AFFILIATE.shortHosts as readonly string[]).includes(host)) {
    return fail(
      "That is a short link. Use SiteStripe's Full link: a short link hides the tag, and the blog build refuses it.",
    );
  }
  if (!(AFFILIATE.hosts as readonly string[]).includes(host)) {
    if (/(^|\.)amazon\.(?!co\.uk$)[a-z.]+$/.test(host)) {
      return fail(`Only amazon.co.uk links count: a UK tag earns nothing on ${host}.`);
    }
    return fail('The link must be on amazon.co.uk.');
  }

  const tags = url.searchParams.getAll('tag');
  if (tags.length === 0) {
    return fail('The link has no tag: paste the link from SiteStripe, not from the address bar.');
  }
  if (tags.length > 1) {
    return fail('The link has more than one tag.');
  }
  const tag = tags[0];
  if (!TAG_RE.test(tag)) {
    return fail(`The tag "${tag}" is not one of yours (nakomis-21 or nakomis-...-21).`);
  }

  const warnings: string[] = [];
  const effective = ctx.effectiveTrackingId;
  if (!effective) {
    warnings.push(
      'No amazon_tracking_id for this post: the blog build will fall back to nakomis-21, so earnings cannot be attributed to the post. Create nakomis-bconn<N>-21 in Associates Central and enter it above.',
    );
  } else if (tag !== effective) {
    warnings.push(
      `The tag is ${tag} but this post uses ${effective}. The blog build rewrites the tag to ${effective}, so earnings are attributed correctly; check you copied the link for the right product.`,
    );
  }
  const asin = asinOf(url.pathname);
  if (!asin) {
    warnings.push('Not a product page (no ASIN in the link).');
  } else if (ctx.otherAsins.map((a) => a.toUpperCase()).includes(asin)) {
    warnings.push('The same product is already attached to another mention. Only the first will be linked.');
  }
  return { ok: true, url: text, tag, ...(asin ? { asin } : {}), warnings };
}

// ── Product mentions ───────────────────────────────────────────────────────

/** Link text of every Amazon link already in the body. */
export function amazonLinkTexts(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g)) {
    try {
      const host = new URL(m[2]).hostname.toLowerCase();
      if (
        /(^|\.)amazon\.[a-z.]+$/.test(host) ||
        (AFFILIATE.shortHosts as readonly string[]).includes(host)
      ) {
        out.push(m[1]);
      }
    } catch {
      // Not a URL: not ours to judge.
    }
  }
  return out;
}

const ANCHOR_FORBIDDEN = /[[\]()`<>{}\n\r]/;

export interface ProductValidationInput {
  picks: ProductPick[];
  body: string;
  /** Ranges of link suggestions already made (a product may not overlap them). */
  linkRanges: Range[];
  /** Text of Amazon links already in the post. */
  existingAmazonTexts: string[];
  maxMentions: number;
}

export interface ProductValidationResult {
  accepted: AffiliateMention[];
  dropped: DroppedSuggestion[];
}

/**
 * The shortest context around the anchor, inside its sentence, that locates it
 * exactly once in the body (the whole sentence in the worst case, which is
 * unique by construction).
 */
function locatorFor(
  body: string,
  quote: string,
  anchor: string,
  at: number,
): { before: string; after: string } {
  const radii = [AFFILIATE.locatorChars, AFFILIATE.locatorChars * 2, Number.POSITIVE_INFINITY];
  for (const r of radii) {
    const before = quote.slice(Math.max(0, at - r), at);
    const after = quote.slice(at + anchor.length, at + anchor.length + r);
    if (occurrences(body, before + anchor + after).length === 1) {
      return { before, after };
    }
  }
  return { before: quote.slice(0, at), after: quote.slice(at + anchor.length) };
}

export function validateProducts(input: ProductValidationInput): ProductValidationResult {
  const { picks, body, linkRanges, existingAmazonTexts, maxMentions } = input;
  const dropped: DroppedSuggestion[] = [];
  const drop = (pick: ProductPick, reason: string): void => {
    dropped.push({ kind: 'affiliate', value: pick.anchor_text, reason });
  };
  const protectedAt = protectedRanges(body);
  const linked = new Set(existingAmazonTexts.map((t) => t.trim().toLowerCase()));
  const seenAnchors = new Set<string>();
  const seenProducts = new Set<string>();
  const located: AffiliateMention[] = [];

  for (const pick of picks) {
    if (!pick.used_by_author) {
      drop(pick, 'Martin did not use this product, or the text does not show he did');
      continue;
    }
    const anchor = pick.anchor_text.trim();
    const words = anchor.split(/\s+/).length;
    if (anchor.length < 2 || anchor.length > 60 || words > 6) {
      drop(pick, 'anchor must be 2 to 60 characters and at most 6 words');
      continue;
    }
    if (ANCHOR_FORBIDDEN.test(anchor)) {
      drop(pick, 'anchor contains brackets, backticks or line breaks');
      continue;
    }
    const quote = pick.quote.trim();
    const quoteAt = occurrences(body, quote);
    if (quote === '' || quoteAt.length === 0) {
      drop(pick, 'the sentence is not in the post');
      continue;
    }
    if (quoteAt.length > 1) {
      drop(pick, 'the sentence appears more than once in the post');
      continue;
    }
    const inQuote = quote.indexOf(anchor);
    if (inQuote === -1) {
      drop(pick, 'the anchor is not in the sentence');
      continue;
    }
    const start = quoteAt[0] + inQuote;
    const end = start + anchor.length;
    if (crossesWordBoundary(body, start, end)) {
      drop(pick, 'anchor starts or ends in the middle of a word');
      continue;
    }
    if (overlapsRange(protectedAt, start, end)) {
      drop(pick, 'anchor sits inside a heading, code, link, image or shortcode');
      continue;
    }
    if (overlapsRange(linkRanges, start, end)) {
      drop(pick, 'anchor overlaps a suggested link');
      continue;
    }
    if (linked.has(anchor.toLowerCase())) {
      drop(pick, 'already linked to Amazon in the post');
      continue;
    }
    const product = pick.product_name.trim().toLowerCase();
    if (seenAnchors.has(anchor.toLowerCase()) || (product !== '' && seenProducts.has(product))) {
      drop(pick, 'that product was already offered');
      continue;
    }
    seenAnchors.add(anchor.toLowerCase());
    if (product !== '') {
      seenProducts.add(product);
    }
    const { before, after } = locatorFor(body, quote, anchor, inQuote);
    located.push({
      id: affiliateId(anchor),
      kind: 'affiliate',
      anchorText: anchor,
      productName: pick.product_name.trim() || anchor,
      quote,
      before,
      after,
      occurrence: { paragraph: paragraphIndex(body, start), offset: start },
      reason: pick.reason.trim() || 'No reason given.',
      decision: 'pending',
    });
  }

  located.sort((a, b) => a.occurrence.offset - b.occurrence.offset);
  for (const extra of located.slice(maxMentions)) {
    dropped.push({
      kind: 'affiliate',
      value: extra.anchorText,
      reason: `more than ${maxMentions} product mentions proposed`,
    });
  }
  return { accepted: located.slice(0, maxMentions), dropped };
}
