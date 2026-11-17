import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { SITE } from '../site.config';
import { getPostsByDate, postUrl } from '../utils/posts';

export async function GET(context: APIContext) {
  const posts = (await getPostsByDate()).filter((p) => !p.data.draft);
  return rss({
    title: SITE.name,
    description: SITE.description,
    site: context.site ?? (SITE.url || context.url.origin),
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: postUrl(post),
      categories: post.data.tags,
    })),
    customData: `<language>${SITE.lang}</language>`,
  });
}
