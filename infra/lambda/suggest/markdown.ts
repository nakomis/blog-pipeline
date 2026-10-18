/**
 * Pure Markdown helpers for link and repo suggestions (PIPE-38).
 *
 * Nothing here touches AWS. The frontmatter delimiter rules match
 * `blog-content/.github/scripts/promote-approved.py` (`---` fence first, closing
 * `---` on its own line).
 */

export interface SplitMarkdown {
  /** The frontmatter block including both fences; `md === head + body`. */
  head: string;
  /** The YAML between the fences, or null when there is none. */
  frontmatter: string | null;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(md: string): SplitMarkdown {
  const match = FRONTMATTER.exec(md);
  if (!match) {
    return { head: '', frontmatter: null, body: md };
  }
  return {
    head: match[0],
    frontmatter: match[1],
    body: md.slice(match[0].length),
  };
}

export interface FrontmatterFacts {
  date?: string;
  publishDate?: string;
  /** Lower-cased `owner/name` of every GitHub repo already listed under `repos:`. */
  repoFullNames: string[];
  /** Lower-cased URLs already listed under `repos:`. */
  repoUrls: string[];
}

function scalar(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:[ \\t]*["']?([^"'\\r\\n]+?)["']?[ \\t]*$`, 'm').exec(
    frontmatter,
  );
  return match?.[1];
}

/** Extract the few facts the suggestion step needs, by targeted regex. */
export function parseFrontmatterFacts(frontmatter: string | null): FrontmatterFacts {
  const facts: FrontmatterFacts = { repoFullNames: [], repoUrls: [] };
  if (!frontmatter) {
    return facts;
  }
  facts.date = scalar(frontmatter, 'date');
  facts.publishDate = scalar(frontmatter, 'publish_date');

  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((l) => /^repos:\s*$/.test(l));
  if (start !== -1) {
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() !== '' && !/^\s/.test(line)) {
        break; // next top-level key
      }
      const url = /\burl:\s*["']?([^"'\s]+)["']?/.exec(line);
      if (url) {
        const lower = url[1].toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
        facts.repoUrls.push(lower);
        const gh = /github\.com\/([^/\s]+)\/([^/\s]+)/.exec(lower);
        if (gh) {
          facts.repoFullNames.push(`${gh[1]}/${gh[2]}`);
        }
      }
    }
  }
  return facts;
}

export type Range = [start: number, end: number];

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

/**
 * Ranges of the body that must never become (or sit inside) a link anchor:
 * fenced code, inline code, headings, Markdown links and images (text and URL),
 * reference links and definitions, autolinks, bare URLs, raw HTML tags and
 * `{{...}}` shortcodes.
 */
export function protectedRanges(body: string): Range[] {
  const ranges: Range[] = [];

  // Fenced code blocks, line by line (``` or ~~~).
  let offset = 0;
  let fence: { marker: string; start: number } | null = null;
  for (const line of body.split('\n')) {
    const lineEnd = offset + line.length;
    const trimmed = line.trimStart();
    const marker = /^(```+|~~~+)/.exec(trimmed)?.[1];
    if (fence) {
      if (marker && marker[0] === fence.marker[0] && marker.length >= fence.marker.length) {
        ranges.push([fence.start, lineEnd]);
        fence = null;
      }
    } else if (marker) {
      fence = { marker, start: offset };
    }
    offset = lineEnd + 1;
  }
  if (fence) {
    ranges.push([fence.start, body.length]);
  }

  const patterns: RegExp[] = [
    /^#{1,6}[ \t].*$/gm, // headings
    /`[^`\n]+`/g, // inline code
    /!?\[[^\]\n]*\]\([^)\n]*\)/g, // links and images
    /!?\[[^\]\n]*\]\[[^\]\n]*\]/g, // reference links
    /^\s*\[[^\]\n]+\]:.*$/gm, // reference definitions
    /<https?:\/\/[^>\s]+>/g, // autolinks
    /https?:\/\/[^\s)<>\]]+/g, // bare URLs
    /<\/?[A-Za-z][^>\n]*>/g, // HTML tags
    /\{\{[\s\S]*?\}\}/g, // shortcodes and image placeholders
  ];
  for (const pattern of patterns) {
    for (const m of body.matchAll(pattern)) {
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  return mergeRanges(ranges);
}

export function overlapsRange(ranges: Range[], start: number, end: number): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

/** Start offsets of every (non-overlapping) occurrence of `needle`. */
export function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === '') {
    return found;
  }
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) {
      return found;
    }
    found.push(at);
    from = at + needle.length;
  }
}

/** Zero-based index of the paragraph (blank-line separated block) holding `offset`. */
export function paragraphIndex(body: string, offset: number): number {
  const before = body.slice(0, offset);
  return (before.match(/\n[ \t]*\r?\n/g) ?? []).length;
}

/** Surrounding text for display, flattened to a single line. */
export function contextAround(
  body: string,
  start: number,
  end: number,
  radius = 80,
): string {
  const from = Math.max(0, start - radius);
  const to = Math.min(body.length, end + radius);
  return `${from > 0 ? '…' : ''}${body.slice(from, to).replace(/\s+/g, ' ').trim()}${
    to < body.length ? '…' : ''
  }`;
}

/** Words in prose: code fences and shortcodes do not count. */
export function wordCount(body: string): number {
  const prose = body
    .replace(/^(```+|~~~+)[\s\S]*?^\1[^\n]*$/gm, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ');
  return (prose.match(/\S+/g) ?? []).length;
}

/**
 * Split the prose into windows of roughly `windowChars` characters on paragraph
 * boundaries, comparable in size to the index's chunks. Fenced code, headings
 * on their own and shortcodes are left out; an over-long paragraph is cut at
 * sentence ends. At most `maxWindows` are returned.
 */
export function windowsOf(
  body: string,
  windowChars: number,
  maxWindows: number,
): string[] {
  const cleaned = body
    .replace(/^(```+|~~~+)[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/\{\{[\s\S]*?\}\}/g, '');
  const paragraphs = cleaned
    .split(/\n[ \t]*\r?\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p !== '');

  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= windowChars) {
      pieces.push(paragraph);
      continue;
    }
    let current = '';
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      if (current !== '' && current.length + sentence.length + 1 > windowChars) {
        pieces.push(current);
        current = sentence;
      } else {
        current = current === '' ? sentence : `${current} ${sentence}`;
      }
    }
    if (current !== '') {
      pieces.push(current);
    }
  }

  const windows: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current !== '' && current.length + piece.length + 1 > windowChars) {
      windows.push(current);
      current = piece;
    } else {
      current = current === '' ? piece : `${current} ${piece}`;
    }
  }
  if (current !== '') {
    windows.push(current);
  }
  return windows.slice(0, maxWindows);
}
