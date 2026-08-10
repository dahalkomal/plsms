import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      nodePolyfills({
        include: ['stream', 'buffer', 'util', 'crypto', 'process'],
        globals: {
          Buffer: true,
          global: true,
          process: true,
        },
      }),
      {
        name: 'admin-reset-api',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url?.startsWith('/api/admin/reset-production-data') && req.method === 'POST') {
              try {
                // @ts-ignore
                const { handleResetProductionData } = await import('./server/adminReset.js');
                let bodyStr = '';
                req.on('data', chunk => { bodyStr += chunk; });
                req.on('end', async () => {
                  let body = {};
                  try { body = JSON.parse(bodyStr || '{}'); } catch(e) {}
                  // @ts-ignore
                  req.body = body;
                  res.setHeader('Content-Type', 'application/json');
                  await handleResetProductionData(req, {
                    status: (code: number) => {
                      res.statusCode = code;
                      return {
                        json: (data: any) => res.end(JSON.stringify(data))
                      };
                    },
                    json: (data: any) => {
                      res.statusCode = 200;
                      res.end(JSON.stringify(data));
                    }
                  });
                });
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, error: err.message }));
              }
              return;
            }

            if (req.url?.startsWith('/api/admin/reset-status') && req.method === 'GET') {
              try {
                // @ts-ignore
                const { handleResetStatus } = await import('./server/adminReset.js');
                res.setHeader('Content-Type', 'application/json');
                handleResetStatus(req, {
                  status: (code: number) => {
                    res.statusCode = code;
                    return {
                      json: (data: any) => res.end(JSON.stringify(data))
                    };
                  },
                  json: (data: any) => {
                    res.statusCode = 200;
                    res.end(JSON.stringify(data));
                  }
                });
              } catch (err: any) {
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, error: err.message }));
              }
              return;
            }

            next();
          });
        }
      }
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
