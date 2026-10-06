const cache = new Map<string, Promise<unknown>>();

/** Fetch a JSON file once per page load. */
export function load<T>(path: string): Promise<T> {
  let p = cache.get(path);
  if (!p) {
    p = fetch(path).then((res) => {
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return res.json();
    });
    cache.set(path, p);
  }
  return p as Promise<T>;
}
