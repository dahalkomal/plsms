import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { handleResetProductionData, handleResetStatus } from './server/adminReset.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.disable('x-powered-by');
app.use(express.json());

// API Endpoints for Controlled Enterprise Reset
app.post('/api/admin/reset-production-data', handleResetProductionData);
app.get('/api/admin/reset-status', handleResetStatus);

const distPath = path.join(__dirname, 'dist');
const assetsPath = path.join(distPath, 'assets');

// 1. Dedicated static route for compiled Vite /assets directory
// Setting fallthrough: false guarantees missing assets return 404 instead of returning index.html
app.use('/assets', express.static(assetsPath, {
  maxAge: '1y',
  immutable: true,
  fallthrough: false
}));

// 2. Serve static files from /dist root (e.g. logos, emblem SVGs, icons)
app.use(express.static(distPath, {
  maxAge: '1h'
}));

// 3. SPA Routing: Serve dist/index.html for all client-side navigation paths (e.g., /, /plsms)
app.get('*', (req, res) => {
  const indexPath = path.join(distPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(500).send('Production build not found in /dist. Run `npm run build` first.');
  }
});

// Catch missing static asset 404 errors safely
app.use((err, req, res, next) => {
  if (err && (err.status === 404 || err.code === 'ENOENT')) {
    return res.status(404).send('Static asset not found');
  }
  next(err);
});

app.listen(PORT, HOST, () => {
  console.log(`PLSMS Web Service listening on http://${HOST}:${PORT}`);
});
