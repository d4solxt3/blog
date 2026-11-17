// Data for [[wiki-link]] hover previews: { slug: { title, date, summary } }.
import { getPostsByDate, formatDate } from '../utils/posts';

export async function GET() {
  const posts = await getPostsByDate();
  const data = Object.fromEntries(
    posts.map((p) => {
      const tldr = p.data.tldr;
      const summary = Array.isArray(tldr) ? tldr.join(' ') : tldr || p.data.subtitle || p.data.description;
      return [p.id, { title: p.data.title, date: formatDate(p.data.date), summary }];
    }),
  );
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
