import { setCV } from '../pipeline/cv';

let loading: Promise<void> | null = null;

/**
 * Downloads public/opencv.js with progress reporting, runs it, and waits for the WASM runtime.
 * Resolves with nothing (not the module): the Emscripten module is "thenable" and would hang a promise.
 */
export function loadOpenCV(onProgress: (fraction: number) => void): Promise<void> {
  loading ??= (async () => {
    const url = new URL('opencv.js', document.baseURI).href;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Could not download OpenCV (${res.status})`);
    // content-length is the compressed size when gzipped, so use the known file size instead.
    const total = __OPENCV_SIZE__;
    const reader = res.body.getReader();
    const chunks: BlobPart[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(0.99, got / total));
    }
    const blobUrl = URL.createObjectURL(new Blob(chunks, { type: 'text/javascript' }));
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = blobUrl;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('OpenCV failed to start'));
      document.head.appendChild(s);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cv: any = (window as any).cv;
    if (!cv.Mat) await new Promise<void>((r) => (cv.onRuntimeInitialized = () => r()));
    delete cv.then;
    setCV(cv);
    onProgress(1);
  })();
  return loading;
}
