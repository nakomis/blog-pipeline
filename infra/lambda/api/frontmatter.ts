import { parse as parseYaml } from 'yaml';

/**
 * Frontmatter parsing and checks for the bag (PIPE-37).
 *
 * Pure functions with no AWS imports. The author's frontmatter (iteration 1)
 * is parsed with the YAML `failsafe` schema, which keeps every scalar a string:
 * an unquoted `date: 2026-10-18` stays text rather than becoming a `Date`, and
 * `approved: true` stays the literal `true`.
 *
 * Every check yields a warning, never a blocker.
 */

export type FrontmatterValue =
  | string
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

export type FrontmatterFields = Record<string, FrontmatterValue>;

export type WarningCode =
  | 'missing-field'
  | 'canonical-mismatch'
  | 'date-mismatch'
  | 'approved-by-hand'
  | 'frontmatter-missing'
  | 'frontmatter-invalid'
  | 'frontmatter-changed'
  | 'repos-malformed';

export interface FrontmatterWarning {
  code: WarningCode;
  field?: string;
  message: string;
}

export interface FrontmatterInfo {
  present: boolean;
  raw: string | null;
  fields: FrontmatterFields | null;
  parseError?: string;
  /** False when the filename could not be determined, so filename checks were skipped. */
  filenameKnown: boolean;
  warnings: FrontmatterWarning[];
}

export interface RepoRef {
  name: string;
  url: string;
}

/** Fields every post must carry. */
export const REQUIRED_FIELDS = [
  'title',
  'date',
  'excerpt',
  'tags',
  'author',
  'canonical',
] as const;

/** Statuses in which `approved` in the frontmatter is legitimate. */
const APPROVED_STATUSES = ['approved', 'published'];

/**
 * Split a Markdown file into its frontmatter block and body. Same delimiter
 * rules as the web app's `stripFrontmatter` and `promote-approved.py`: the file
 * must start with `---` and the block ends at the next `---` line. CRLF is
 * tolerated.
 */
export function splitFrontmatter(
  markdown: string,
): { raw: string; body: string } | null {
  const text = markdown.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    return null;
  }
  const match = /\n---[ \t]*(\n|$)/.exec(text.slice(3));
  if (!match) {
    return null;
  }
  const rawEnd = 3 + match.index;
  return {
    raw: text.slice(4, rawEnd),
    body: text.slice(rawEnd + match[0].length),
  };
}

/** Parse a frontmatter block into string-valued fields. */
export function parseFrontmatter(
  raw: string,
): { fields: FrontmatterFields } | { parseError: string } {
  let doc: unknown;
  try {
    doc = parseYaml(raw, { schema: 'failsafe' });
  } catch (err) {
    return {
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
  if (doc === null || doc === undefined) {
    return { fields: {} };
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    return { parseError: 'Frontmatter is not a set of key: value pairs' };
  }
  return { fields: doc as FrontmatterFields };
}

/** Split and parse in one go, as the API needs it. */
export function readFrontmatter(markdown: string): {
  present: boolean;
  raw: string | null;
  fields: FrontmatterFields | null;
  parseError?: string;
} {
  const split = splitFrontmatter(markdown);
  if (!split) {
    return { present: false, raw: null, fields: null };
  }
  const parsed = parseFrontmatter(split.raw);
  return 'parseError' in parsed
    ? { present: true, raw: split.raw, fields: null, parseError: parsed.parseError }
    : { present: true, raw: split.raw, fields: parsed.fields };
}

/**
 * Normalise `repos` to `{ name, url }[]`. Malformed entries are dropped and
 * flagged so the caller can warn.
 */
export function parseRepos(fields: FrontmatterFields | null): {
  repos: RepoRef[];
  malformed: boolean;
} {
  const value = fields?.repos;
  if (value === undefined) {
    return { repos: [], malformed: false };
  }
  if (!Array.isArray(value)) {
    return { repos: [], malformed: true };
  }
  const repos: RepoRef[] = [];
  let malformed = false;
  for (const entry of value) {
    if (
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof entry.name === 'string' &&
      typeof entry.url === 'string' &&
      entry.url.trim() !== ''
    ) {
      repos.push({ name: entry.name, url: entry.url.trim() });
    } else {
      malformed = true;
    }
  }
  return { repos, malformed };
}

/**
 * The source filename (`YYYY-MM-DD-slug.md`). Items queued since PIPE-37 carry
 * it; for older items it is recovered from a `canonical` ending in
 * `/<date>-<slug>`. Returns undefined if neither works.
 */
export function deriveSourceFile(
  sourceFile: unknown,
  slug: string,
  fields: FrontmatterFields | null,
): string | undefined {
  if (typeof sourceFile === 'string' && sourceFile !== '') {
    return sourceFile;
  }
  const canonical = fields?.canonical;
  if (typeof canonical === 'string') {
    const tail = canonical.replace(/\/+$/, '').split('/').pop() ?? '';
    const match = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(tail);
    if (match && match[2] === slug) {
      return `${tail}.md`;
    }
  }
  return undefined;
}

function isEmpty(value: FrontmatterValue | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim() === '';
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return Object.keys(value).length === 0;
}

function stable(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface CheckInput {
  present: boolean;
  parseError?: string;
  fields: FrontmatterFields | null;
  /** Filename, if known (see `deriveSourceFile`). */
  sourceFile?: string;
  status: string | undefined;
  blogBaseUrl: string;
  /**
   * The staged final draft's frontmatter, when it is a later iteration than
   * the author's. Undefined when there is nothing to compare.
   */
  finalRead?: { present: boolean; fields: FrontmatterFields | null };
}

/** Run every frontmatter check. All results are warnings. */
export function checkFrontmatter(input: CheckInput): FrontmatterWarning[] {
  const warnings: FrontmatterWarning[] = [];
  if (!input.present) {
    warnings.push({
      code: 'frontmatter-missing',
      message: "The author's draft has no frontmatter block.",
    });
    return warnings;
  }
  if (input.parseError !== undefined || input.fields === null) {
    warnings.push({
      code: 'frontmatter-invalid',
      message: `Frontmatter could not be parsed: ${input.parseError ?? 'unknown error'}`,
    });
    return warnings;
  }
  const { fields } = input;

  for (const name of REQUIRED_FIELDS) {
    if (isEmpty(fields[name])) {
      warnings.push({
        code: 'missing-field',
        field: name,
        message: `Required field '${name}' is missing or empty.`,
      });
    }
  }

  const prefix = input.sourceFile
    ? /^(\d{4}-\d{2}-\d{2})-/.exec(input.sourceFile)?.[1]
    : undefined;
  if (input.sourceFile && prefix) {
    const date = fields.date;
    if (typeof date === 'string' && date !== '' && date !== prefix) {
      warnings.push({
        code: 'date-mismatch',
        field: 'date',
        message: `date '${date}' does not match the filename's date prefix '${prefix}'.`,
      });
    }
    const canonical = fields.canonical;
    const expected = `${input.blogBaseUrl.replace(/\/+$/, '')}/${input.sourceFile.replace(/\.md$/, '')}`;
    if (
      typeof canonical === 'string' &&
      canonical !== '' &&
      canonical.replace(/\/+$/, '') !== expected
    ) {
      warnings.push({
        code: 'canonical-mismatch',
        field: 'canonical',
        message: `canonical '${canonical}' should be '${expected}'.`,
      });
    }
  }

  if (
    fields.approved !== undefined &&
    !APPROVED_STATUSES.includes(input.status ?? '')
  ) {
    warnings.push({
      code: 'approved-by-hand',
      field: 'approved',
      message:
        "'approved' is set in the author's frontmatter but the post has not been approved in the bag.",
    });
  }

  if (parseRepos(fields).malformed) {
    warnings.push({
      code: 'repos-malformed',
      field: 'repos',
      message: "'repos' should be a list of entries with a name and a url.",
    });
  }

  if (input.finalRead) {
    const { present, fields: finalFields } = input.finalRead;
    const same =
      present &&
      finalFields !== null &&
      stable(finalFields) === stable(fields);
    if (!same) {
      warnings.push({
        code: 'frontmatter-changed',
        message:
          "The staged version's frontmatter differs from the author's. Promotion keeps the author's, so the change will be ignored.",
      });
    }
  }

  return warnings;
}

/** Assemble the API's `frontmatter` object from the author's and final drafts. */
export function buildFrontmatterInfo(args: {
  originalMarkdown: string;
  finalMarkdown?: string;
  slug: string;
  sourceFile?: unknown;
  status: string | undefined;
  blogBaseUrl: string;
}): FrontmatterInfo {
  const original = readFrontmatter(args.originalMarkdown);
  const sourceFile = deriveSourceFile(args.sourceFile, args.slug, original.fields);
  const finalRead =
    args.finalMarkdown !== undefined && args.finalMarkdown !== args.originalMarkdown
      ? readFrontmatter(args.finalMarkdown)
      : undefined;
  const warnings = checkFrontmatter({
    present: original.present,
    parseError: original.parseError,
    fields: original.fields,
    sourceFile,
    status: args.status,
    blogBaseUrl: args.blogBaseUrl,
    finalRead,
  });
  return {
    present: original.present,
    raw: original.raw,
    fields: original.fields,
    ...(original.parseError !== undefined ? { parseError: original.parseError } : {}),
    filenameKnown: sourceFile !== undefined,
    warnings,
  };
}
