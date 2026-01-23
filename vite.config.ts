import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// Middleware to handle file system operations
const fileSystemMiddleware = () => ({
  name: 'file-system-middleware',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url.startsWith('/api/datasets')) {
        // GET /api/datasets: Recursively scan 'datasets' folder
        try {
          const datasetsDir = path.resolve(__dirname, 'datasets');
          if (!fs.existsSync(datasetsDir)) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify([]));
            return;
          }

          const metadataPath = path.join(datasetsDir, '_metadata.json');
          let metadata = {};
          if (fs.existsSync(metadataPath)) {
            try {
              metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            } catch (e) {
              console.error("Failed to parse metadata", e);
            }
          }

          const getFiles = (dir) => {
            let results = [];
            const list = fs.readdirSync(dir);
            list.forEach(file => {
              const filePath = path.join(dir, file);
              const stat = fs.statSync(filePath);
              if (stat && stat.isDirectory()) {
                results = results.concat(getFiles(filePath));
              } else {
                // Filter for images
                if (/\.(jpg|jpeg|png|webp|bmp)$/i.test(file)) {
                  // Check for corresponding txt file
                  const ext = path.extname(file);
                  const baseName = path.basename(file, ext);
                  const txtPath = path.join(dir, baseName + '.txt');

                  // Relative path for URL
                  const relativePath = path.relative(path.resolve(__dirname), filePath).replace(/\\/g, '/');
                  // Key for metadata: relative path from datasets root
                  // e.g. "folder/image.jpg"
                  const metaKey = path.relative(datasetsDir, filePath).replace(/\\/g, '/');
                  const fileMeta = metadata[metaKey] || {};

                  results.push({
                    name: file,
                    folder: path.relative(path.resolve(__dirname, 'datasets'), dir).replace(/\\/g, '/') || 'Unsorted',
                    imageUrl: '/' + relativePath,
                    txtPath: fs.existsSync(txtPath) ? path.relative(path.resolve(__dirname), txtPath).replace(/\\/g, '/') : null,
                    fullPath: filePath, // For logging/debugging
                    fullTxtPath: txtPath,
                    // Merge Metadata
                    status: fileMeta.status,
                    isModified: fileMeta.isModified,
                    assignedWorker: fileMeta.assignedWorker,
                    reviewerNotes: fileMeta.reviewerNotes,
                    lastUpdated: fileMeta.lastUpdated
                  });
                }
              }
            });
            return results;
          }

          const files = getFiles(datasetsDir);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        } catch (e) {
          console.error(e);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/metadata') && req.method === 'POST') {
        // POST /api/metadata (Body: { key: string, updates: any })
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const datasetsDir = path.resolve(__dirname, 'datasets');
            if (!fs.existsSync(datasetsDir)) fs.mkdirSync(datasetsDir);
            const metadataPath = path.join(datasetsDir, '_metadata.json');

            let metadata = {};
            if (fs.existsSync(metadataPath)) {
              try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')); } catch (e) { }
            }

            const { key, updates } = JSON.parse(body);
            // key is relative path from datasets root e.g. "folder/image.jpg"

            if (key && updates) {
              metadata[key] = { ...(metadata[key] || {}), ...updates };
              fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
            }

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else if (req.url.startsWith('/api/label-files')) {
        // GET /api/label-files: List .txt files in 'labels' folder
        try {
          const labelsDir = path.resolve(__dirname, 'labels');
          if (!fs.existsSync(labelsDir)) {
            fs.mkdirSync(labelsDir);
          }
          const files = fs.readdirSync(labelsDir).filter(f => f.endsWith('.txt'));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(files));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (req.url.startsWith('/api/label') && req.method === 'GET') {
        // GET /api/label?path=...
        try {
          const url = new URL(req.url, `http://${req.headers.host}`);
          const labelPath = url.searchParams.get('path');
          if (!labelPath) throw new Error('Path required');

          const fullPath = path.resolve(__dirname, labelPath);
          if (fs.existsSync(fullPath)) {
            const content = fs.readFileSync(fullPath, 'utf-8');
            res.setHeader('Content-Type', 'text/plain');
            res.end(content);
          } else {
            res.setHeader('Content-Type', 'text/plain');
            res.end('');
          }
        } catch (e) {
          res.statusCode = 500;
          res.end(e.message);
        }
      } else if (req.url.startsWith('/api/save') && req.method === 'POST') {
        // POST /api/save (Body: { path: string, content: string })
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const fullPath = path.resolve(__dirname, data.path);

            // Ensure directory exists (optional, but safe)
            // fs.mkdirSync(path.dirname(fullPath), { recursive: true });

            fs.writeFileSync(fullPath, data.content, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            console.error(e);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } else {
        next();
      }
    });
  }
});

export default defineConfig({
  plugins: [react(), fileSystemMiddleware()],
  server: {
    port: 5173,
    open: true
  }
});