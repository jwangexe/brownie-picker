/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** Dev-only endpoint the batch page uses to save corner sidecar files into test-images/. */
function saveCornersPlugin(): Plugin {
  return {
    name: 'save-corners',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save-corners', (req, res) => {
        if (req.method !== 'POST') return void res.writeHead(405).end();
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const { image, corners } = JSON.parse(body);
            const name = basename(String(image)).replace(/\.[^.]+$/, '');
            const dir = String(image).includes('/synthetic/') ? 'test-images/synthetic' : 'test-images';
            writeFileSync(join(dir, `${name}.corners.json`), JSON.stringify({ corners }, null, 2) + '\n');
            res.writeHead(200).end('ok');
          } catch (e) {
            res.writeHead(400).end(String(e));
          }
        });
      });
    },
  };
}

let opencvSize = 10_000_000;
try {
  opencvSize = statSync('node_modules/@techstark/opencv-js/dist/opencv.js').size;
} catch {}

export default defineConfig(({ mode }) => ({
  // Relative base so the build works on GitHub Pages (/repo-name/), Vercel or any static host.
  base: './',
  define: { __OPENCV_SIZE__: JSON.stringify(opencvSize) },
  plugins: [saveCornersPlugin(), ...(mode === 'phone' ? [basicSsl()] : [])],
  build: {
    // Only the app ships; batch.html is a dev tool that reads local test-images/.
    rollupOptions: { input: 'index.html' },
  },
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
}));
