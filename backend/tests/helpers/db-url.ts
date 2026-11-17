/** Tests never touch the dev database: `fym` -> `fym_test`. */
export function toTestUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const name = url.pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) url.pathname = `/${name}_test`;
  return url.toString();
}

export function databaseName(url: string): string {
  return new URL(url).pathname.replace(/^\//, '');
}
