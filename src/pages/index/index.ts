import type { APIRoute } from 'astro';

export const prerender = false;
export const GET: APIRoute = ({ redirect, url }) => redirect('/archive/' + url.search, 301);
