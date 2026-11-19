/* The OpenCV.js module is injected at runtime (browser: loaded from public/opencv.js,
 * tests: the @techstark/opencv-js npm package), so pipeline code stays environment-agnostic. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let cv: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setCV(module: any) {
  cv = module;
}

/** Collects Mats (and MatVectors) so they can all be freed in one `finally`. iOS Safari dies quickly on leaks. */
export class MatPool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private items: any[] = [];
  add<T extends { delete(): void }>(m: T): T {
    this.items.push(m);
    return m;
  }
  free() {
    for (const m of this.items) {
      try {
        m.delete();
      } catch {
        /* already freed */
      }
    }
    this.items = [];
  }
}
