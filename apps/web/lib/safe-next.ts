/** 登入後要回去的站內路徑；拒絕 `//host` 與 `/\host` 這類會被瀏覽器當成外部網址的值。 */
export function safeNext(value: unknown): string {
  return typeof value === 'string' && /^\/(?![/\\])/.test(value) ? value : '/projects';
}
