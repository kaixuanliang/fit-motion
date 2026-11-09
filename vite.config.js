import { defineConfig } from 'vite';

/**
 * Inline the complete app (JS + CSS + fonts) into index.html so the exact
 * same build can run from an Android WebView asset:// origin without a server.
 */
function singleFile() {
  return {
    name: 'fitmotion-single-file',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlAsset = bundle['index.html'];
      if (!htmlAsset) return;
      let html = String(htmlAsset.source);

      for (const [name, asset] of Object.entries(bundle)) {
        if (name.endsWith('.css')) {
          const css = String(asset.source);
          html = html.replace(
            new RegExp(`<link[^>]+href="[^"]*${escapeRegExp(name)}"[^>]*>`),
            `<style>${css}</style>`,
          );
          delete bundle[name];
        }
        if (name.endsWith('.js') && name !== 'index.html') {
          const js = String(asset.source);
          const scriptTag = new RegExp(
            `<script[^>]*src="[^"]*${escapeRegExp(name)}"[^>]*></script>`,
          );
          if (scriptTag.test(html)) {
            html = html.replace(scriptTag, `<script>${js}</script>`);
            delete bundle[name];
          }
        }
      }

      htmlAsset.source = html;
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default defineConfig({
  base: './',
  plugins: [singleFile()],
  build: {
    target: 'es2019',
    cssCodeSplit: false,
    assetsInlineLimit: 12 * 1024 * 1024,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
  },
});
