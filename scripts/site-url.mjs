export function normalizeSiteUrl(value) {
  const address = String(value ?? '').trim();
  if (!address) return '';
  const url = new URL(address.includes('://') ? address : 'https://' + address);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid website address');
  }
  return url.href.replace(/\/$/, '');
}
