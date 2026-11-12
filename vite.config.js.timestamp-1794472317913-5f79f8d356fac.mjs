// vite.config.js
import { defineConfig } from "file:///D:/Mine/fit-motion/node_modules/vite/dist/node/index.js";
function singleFile() {
  return {
    name: "fitmotion-single-file",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlAsset = bundle["index.html"];
      if (!htmlAsset) return;
      let html = String(htmlAsset.source);
      for (const [name, asset] of Object.entries(bundle)) {
        if (name.endsWith(".css")) {
          const css = String(asset.source);
          html = html.replace(
            new RegExp(`<link[^>]+href="[^"]*${escapeRegExp(name)}"[^>]*>`),
            `<style>${css}</style>`
          );
          delete bundle[name];
        }
        if (name.endsWith(".js") && name !== "index.html") {
          const js = String(asset.source);
          const scriptTag = new RegExp(
            `<script[^>]*src="[^"]*${escapeRegExp(name)}"[^>]*></script>`
          );
          if (scriptTag.test(html)) {
            html = html.replace(scriptTag, `<script>${js}</script>`);
            delete bundle[name];
          }
        }
      }
      htmlAsset.source = html;
    }
  };
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var vite_config_default = defineConfig({
  base: "./",
  plugins: [singleFile()],
  build: {
    target: "es2019",
    cssCodeSplit: false,
    assetsInlineLimit: 12 * 1024 * 1024,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "assets/app.js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJEOlxcXFxNaW5lXFxcXGZpdC1tb3Rpb25cIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkQ6XFxcXE1pbmVcXFxcZml0LW1vdGlvblxcXFx2aXRlLmNvbmZpZy5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vRDovTWluZS9maXQtbW90aW9uL3ZpdGUuY29uZmlnLmpzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSc7XG5cbi8qKlxuICogSW5saW5lIHRoZSBjb21wbGV0ZSBhcHAgKEpTICsgQ1NTICsgZm9udHMpIGludG8gaW5kZXguaHRtbCBzbyB0aGUgZXhhY3RcbiAqIHNhbWUgYnVpbGQgY2FuIHJ1biBmcm9tIGFuIEFuZHJvaWQgV2ViVmlldyBhc3NldDovLyBvcmlnaW4gd2l0aG91dCBhIHNlcnZlci5cbiAqL1xuZnVuY3Rpb24gc2luZ2xlRmlsZSgpIHtcbiAgcmV0dXJuIHtcbiAgICBuYW1lOiAnZml0bW90aW9uLXNpbmdsZS1maWxlJyxcbiAgICBhcHBseTogJ2J1aWxkJyxcbiAgICBlbmZvcmNlOiAncG9zdCcsXG4gICAgZ2VuZXJhdGVCdW5kbGUoX29wdGlvbnMsIGJ1bmRsZSkge1xuICAgICAgY29uc3QgaHRtbEFzc2V0ID0gYnVuZGxlWydpbmRleC5odG1sJ107XG4gICAgICBpZiAoIWh0bWxBc3NldCkgcmV0dXJuO1xuICAgICAgbGV0IGh0bWwgPSBTdHJpbmcoaHRtbEFzc2V0LnNvdXJjZSk7XG5cbiAgICAgIGZvciAoY29uc3QgW25hbWUsIGFzc2V0XSBvZiBPYmplY3QuZW50cmllcyhidW5kbGUpKSB7XG4gICAgICAgIGlmIChuYW1lLmVuZHNXaXRoKCcuY3NzJykpIHtcbiAgICAgICAgICBjb25zdCBjc3MgPSBTdHJpbmcoYXNzZXQuc291cmNlKTtcbiAgICAgICAgICBodG1sID0gaHRtbC5yZXBsYWNlKFxuICAgICAgICAgICAgbmV3IFJlZ0V4cChgPGxpbmtbXj5dK2hyZWY9XCJbXlwiXSoke2VzY2FwZVJlZ0V4cChuYW1lKX1cIltePl0qPmApLFxuICAgICAgICAgICAgYDxzdHlsZT4ke2Nzc308L3N0eWxlPmAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBkZWxldGUgYnVuZGxlW25hbWVdO1xuICAgICAgICB9XG4gICAgICAgIGlmIChuYW1lLmVuZHNXaXRoKCcuanMnKSAmJiBuYW1lICE9PSAnaW5kZXguaHRtbCcpIHtcbiAgICAgICAgICBjb25zdCBqcyA9IFN0cmluZyhhc3NldC5zb3VyY2UpO1xuICAgICAgICAgIGNvbnN0IHNjcmlwdFRhZyA9IG5ldyBSZWdFeHAoXG4gICAgICAgICAgICBgPHNjcmlwdFtePl0qc3JjPVwiW15cIl0qJHtlc2NhcGVSZWdFeHAobmFtZSl9XCJbXj5dKj48L3NjcmlwdD5gLFxuICAgICAgICAgICk7XG4gICAgICAgICAgaWYgKHNjcmlwdFRhZy50ZXN0KGh0bWwpKSB7XG4gICAgICAgICAgICBodG1sID0gaHRtbC5yZXBsYWNlKHNjcmlwdFRhZywgYDxzY3JpcHQ+JHtqc308L3NjcmlwdD5gKTtcbiAgICAgICAgICAgIGRlbGV0ZSBidW5kbGVbbmFtZV07XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGh0bWxBc3NldC5zb3VyY2UgPSBodG1sO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGVzY2FwZVJlZ0V4cCh2YWx1ZSkge1xuICByZXR1cm4gdmFsdWUucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csICdcXFxcJCYnKTtcbn1cblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgYmFzZTogJy4vJyxcbiAgcGx1Z2luczogW3NpbmdsZUZpbGUoKV0sXG4gIGJ1aWxkOiB7XG4gICAgdGFyZ2V0OiAnZXMyMDE5JyxcbiAgICBjc3NDb2RlU3BsaXQ6IGZhbHNlLFxuICAgIGFzc2V0c0lubGluZUxpbWl0OiAxMiAqIDEwMjQgKiAxMDI0LFxuICAgIGNodW5rU2l6ZVdhcm5pbmdMaW1pdDogNDA5NixcbiAgICByb2xsdXBPcHRpb25zOiB7XG4gICAgICBvdXRwdXQ6IHtcbiAgICAgICAgZm9ybWF0OiAnaWlmZScsXG4gICAgICAgIGlubGluZUR5bmFtaWNJbXBvcnRzOiB0cnVlLFxuICAgICAgICBlbnRyeUZpbGVOYW1lczogJ2Fzc2V0cy9hcHAuanMnLFxuICAgICAgICBhc3NldEZpbGVOYW1lczogJ2Fzc2V0cy9bbmFtZV1bZXh0bmFtZV0nLFxuICAgICAgfSxcbiAgICB9LFxuICB9LFxuICBzZXJ2ZXI6IHtcbiAgICBob3N0OiAnMTI3LjAuMC4xJyxcbiAgICBwb3J0OiA1MTc4LFxuICAgIHN0cmljdFBvcnQ6IHRydWUsXG4gIH0sXG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBOE8sU0FBUyxvQkFBb0I7QUFNM1EsU0FBUyxhQUFhO0FBQ3BCLFNBQU87QUFBQSxJQUNMLE1BQU07QUFBQSxJQUNOLE9BQU87QUFBQSxJQUNQLFNBQVM7QUFBQSxJQUNULGVBQWUsVUFBVSxRQUFRO0FBQy9CLFlBQU0sWUFBWSxPQUFPLFlBQVk7QUFDckMsVUFBSSxDQUFDLFVBQVc7QUFDaEIsVUFBSSxPQUFPLE9BQU8sVUFBVSxNQUFNO0FBRWxDLGlCQUFXLENBQUMsTUFBTSxLQUFLLEtBQUssT0FBTyxRQUFRLE1BQU0sR0FBRztBQUNsRCxZQUFJLEtBQUssU0FBUyxNQUFNLEdBQUc7QUFDekIsZ0JBQU0sTUFBTSxPQUFPLE1BQU0sTUFBTTtBQUMvQixpQkFBTyxLQUFLO0FBQUEsWUFDVixJQUFJLE9BQU8sd0JBQXdCLGFBQWEsSUFBSSxDQUFDLFNBQVM7QUFBQSxZQUM5RCxVQUFVLEdBQUc7QUFBQSxVQUNmO0FBQ0EsaUJBQU8sT0FBTyxJQUFJO0FBQUEsUUFDcEI7QUFDQSxZQUFJLEtBQUssU0FBUyxLQUFLLEtBQUssU0FBUyxjQUFjO0FBQ2pELGdCQUFNLEtBQUssT0FBTyxNQUFNLE1BQU07QUFDOUIsZ0JBQU0sWUFBWSxJQUFJO0FBQUEsWUFDcEIseUJBQXlCLGFBQWEsSUFBSSxDQUFDO0FBQUEsVUFDN0M7QUFDQSxjQUFJLFVBQVUsS0FBSyxJQUFJLEdBQUc7QUFDeEIsbUJBQU8sS0FBSyxRQUFRLFdBQVcsV0FBVyxFQUFFLFdBQVc7QUFDdkQsbUJBQU8sT0FBTyxJQUFJO0FBQUEsVUFDcEI7QUFBQSxRQUNGO0FBQUEsTUFDRjtBQUVBLGdCQUFVLFNBQVM7QUFBQSxJQUNyQjtBQUFBLEVBQ0Y7QUFDRjtBQUVBLFNBQVMsYUFBYSxPQUFPO0FBQzNCLFNBQU8sTUFBTSxRQUFRLHVCQUF1QixNQUFNO0FBQ3BEO0FBRUEsSUFBTyxzQkFBUSxhQUFhO0FBQUEsRUFDMUIsTUFBTTtBQUFBLEVBQ04sU0FBUyxDQUFDLFdBQVcsQ0FBQztBQUFBLEVBQ3RCLE9BQU87QUFBQSxJQUNMLFFBQVE7QUFBQSxJQUNSLGNBQWM7QUFBQSxJQUNkLG1CQUFtQixLQUFLLE9BQU87QUFBQSxJQUMvQix1QkFBdUI7QUFBQSxJQUN2QixlQUFlO0FBQUEsTUFDYixRQUFRO0FBQUEsUUFDTixRQUFRO0FBQUEsUUFDUixzQkFBc0I7QUFBQSxRQUN0QixnQkFBZ0I7QUFBQSxRQUNoQixnQkFBZ0I7QUFBQSxNQUNsQjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxRQUFRO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixZQUFZO0FBQUEsRUFDZDtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
