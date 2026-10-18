import type { Candidate, RepoInfo } from './schema';

/**
 * Prompts for the link and repo suggestion step (PIPE-38).
 *
 * The model chooses from closed lists and never writes a URL. The central risk
 * is a false positive — a passage that merely resembles an earlier post — so
 * the prompt is firm that no suggestion is better than a doubtful one.
 */

export const SUGGEST_SYSTEM_PROMPT = `
You propose cross-links for a blog post by Martin Harris (blog.nakomis.com).
You choose from closed lists given to you. You never write, edit or invent a
URL, a slug or a repository name: copy them exactly from the lists.

LINKS TO EARLIER POSTS

Suggest a link only when a passage genuinely refers to the specific subject of
an earlier post: the same system, event, experiment or idea, not merely
something similar, a shared word, a similar phrase or the same general topic.
If a reader following the link would be surprised by where it leads, do not
suggest it. Suggesting nothing is a good answer; most posts deserve few links
or none.

A shared word is not a shared subject. For example, a sentence about "a final
review on the most capable model" that describes one model reviewing some code
must not link to a post about a panel of several models reviewing each other's
work, however similar the vocabulary. Set same_subject to false whenever you
are not sure the passage is about the very thing the earlier post covers.

Rules for each link:
- anchor_text is copied verbatim from the post and is SHORT: 2 to 6 words, a
  name or noun phrase such as "the one-media-element approach" or "the Cabal".
  Never a whole sentence or clause: anything over 6 words is discarded. It must
  appear exactly once in the post. Do not rewrite the sentence.
- Never anchor inside a heading, a code block or span, an existing link, an
  image or a {{...}} shortcode.
- target_slug is copied exactly from the candidate list.
- At most one link per target post, at most one per paragraph, and no more than
  the maximum stated in the request.
- reason is one short, plain sentence for the author, saying what in the post
  refers to the earlier post.

REPOSITORIES

Suggest a repository for the post's "repos" list only when the post discusses
it: it describes what the repository does or how it works, or is clearly about
it. A passing mention in a list of unrelated things is not enough. Choose only
from the list of repositories given, and quote in evidence_quote the exact
sentence from the post that shows it. Do not suggest a repository already
listed.

Write in British English. Return only the JSON object the schema asks for.
`.trim();

export interface PromptInput {
  body: string;
  mode: 'evidence' | 'catalogue' | 'none';
  candidates: Candidate[];
  repos: RepoInfo[];
  maxLinks: number;
}

function describeCandidate(c: Candidate, withEvidence: boolean): string {
  const lines = [`- slug: ${c.slug}`, `  title: ${c.title}`, `  date: ${c.date}`];
  if (c.excerpt) {
    lines.push(`  summary: ${c.excerpt}`);
  }
  if (withEvidence) {
    for (const e of c.evidence) {
      lines.push(`  matched passage in this post: ${e.passage}`);
      lines.push(`  from the earlier post: ${e.earlier}`);
    }
  }
  return lines.join('\n');
}

export function buildSuggestPrompt(input: PromptInput): string {
  const sections: string[] = [`## The post\n\n${input.body}`];

  if (input.candidates.length > 0) {
    const intro =
      input.mode === 'evidence'
        ? 'Earlier posts that may be relevant (retrieved by similarity; similarity alone does not justify a link):'
        : 'Every earlier post that could be linked (no retrieval signal; be especially strict):';
    sections.push(
      `## Earlier posts you may link to\n\n${intro}\n\n` +
        input.candidates.map((c) => describeCandidate(c, input.mode === 'evidence')).join('\n'),
    );
    sections.push(`Suggest at most ${input.maxLinks} link${input.maxLinks === 1 ? '' : 's'}.`);
  } else {
    sections.push('## Earlier posts you may link to\n\nNone. Return an empty "links" list.');
  }

  if (input.repos.length > 0) {
    sections.push(
      '## Public repositories the post names\n\n' +
        input.repos
          .map((r) => `- ${r.fullName}${r.description ? `: ${r.description}` : ''}`)
          .join('\n'),
    );
  } else {
    sections.push('## Public repositories the post names\n\nNone. Return an empty "repos" list.');
  }
  return sections.join('\n\n');
}
