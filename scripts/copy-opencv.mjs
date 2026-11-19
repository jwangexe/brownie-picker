// Copies the pinned OpenCV.js build from node_modules into public/ so it is
// served as a plain static file (loaded at runtime, not bundled by Vite).
import { copyFileSync, existsSync, statSync } from 'node:fs';

const src = 'node_modules/@techstark/opencv-js/dist/opencv.js';
const dst = 'public/opencv.js';

if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) {
  copyFileSync(src, dst);
  console.log(`copied ${src} -> ${dst}`);
}
