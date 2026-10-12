/** Local filenames only: matches Android ContentIngressPolicy.safeName. */
export function safeFileName(raw: unknown, fallback = 'file'): string {
  const clean = (value: string) => (value.split(/[\\/]/).pop() ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f<>:"|?*]/g, '_').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  let name = clean(typeof raw === 'string' ? raw : '') || clean(fallback) || 'file';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  if (name.length <= 180) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  return ext.length > 1 && ext.length <= 17 ? name.slice(0, 180 - ext.length) + ext : name.slice(0, 180);
}

/** Avoid overwrites, including on case-insensitive extraction filesystems. */
export function uniqueSafeFileName(raw: unknown, fallback: string, used: Set<string>): string {
  const base = safeFileName(raw, fallback);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 && base.length - dot <= 17 ? base.slice(dot) : '';
  const stem = ext ? base.slice(0, -ext.length) : base;
  let name = base;
  for (let n = 1; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = stem.slice(0, 180 - ext.length - suffix.length) + suffix + ext;
  }
  used.add(name.toLowerCase());
  return name;
}
