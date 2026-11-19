import { createRequire } from 'node:module';
import { setCV } from '../src/pipeline/cv';

let ready: Promise<unknown> | null = null;

/**
 * Initialises OpenCV.js (WASM) in Node once and injects it into the pipeline. Loaded with Node's own
 * require: going through Vite's module transform makes the 13 MB file hang.
 */
export function initCV(): Promise<unknown> {
  ready ??= (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let c: any = createRequire(import.meta.url)('@techstark/opencv-js');
    if (!c.Mat) await new Promise<void>((r) => (c.onRuntimeInitialized = () => r()));
    // The Emscripten module is "thenable"; resolving a promise with it would loop forever.
    delete c.then;
    setCV(c);
  })();
  return ready;
}
