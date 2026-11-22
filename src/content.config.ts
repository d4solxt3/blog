import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/**
 * Every .md / .mdx file in /content/posts becomes a post.
 * Files starting with an underscore are ignored (handy for templates).
 */
const posts = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './content/posts' }),
  schema: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    /** Short excerpt for the front page and meta description. */
    description: z.string(),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    /** Optional summary rendered as a "tldr.txt" window at the top of the post. */
    tldr: z.union([z.string(), z.array(z.string())]).optional(),
    /** Drafts show (marked [DRAFT]) while running `npm run dev`, never in a build. */
    draft: z.boolean().default(false),
    /** Pinned threads sit at the top of the board with a [PIN] badge. */
    pinned: z.boolean().default(false),
    /** Reading font for this post; overrides site.config.json's defaultFont. */
    font: z.enum(['sans', 'serif', 'mono']).optional(),
    /** Group posts into a sequence: "Part 2 of 3 in <series>". */
    series: z.string().optional(),
    seriesOrder: z.number().optional(),
    /** Set to false to switch off highlight-to-comment on this post. */
    annotations: z.boolean().default(true),
    /** Per-post LaTeX preamble macros (\newcommand, \DeclareMathOperator, etc.). */
    macros: z.string().optional(),
    /** Per-post BibTeX bibliography entries. */
    bibliography: z.string().optional(),
    /** Per-post citation style override; falls back to site.config.json's latex.citationStyle. */
    citationStyle: z.enum(['numeric', 'author-year']).optional(),
  }),
});

export const collections = { posts };
