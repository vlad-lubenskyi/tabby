import path from "path"
import { readFileSync } from "node:fs"
import { defineConfig, type UserConfig, type Plugin } from "vite"
import swc from "unplugin-swc"
import yaml from "@rollup/plugin-yaml"
import pugCompiler from "pug"
import gettextParser from "gettext-parser"

/**
 * Handle `.node` native binary addons: return an empty module so Rolldown/Vite
 * does not attempt to parse them as UTF-8 source. This mirrors webpack's built-in
 * behaviour with target:'web' — the JS wrapper code of native packages loads fine;
 * any call that reaches the actual binding will throw at runtime (expected until
 * these services are migrated to main-process IPC).
 */
function nodeAddonPlugin(): Plugin {
  return {
    name: "node-addon-files",
    load(id) {
      if (id.endsWith(".node")) return "export default {}"
      return null
    },
  }
}

/** Convert webpack-style static asset requires to Vite asset URLs. */
function assetRequirePlugin(): Plugin {
  return {
    name: "require-assets",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith(".ts")) return null
      const imports: string[] = []
      let transformed = code.replace(/require\((['"])([^'"]+\.svg)\1\)/g, (_match, _quote, file) => {
        const name = `__svgAsset${imports.length}`
        imports.push(`import ${name} from ${JSON.stringify(`${file}?raw`)}`)
        return name
      })
      transformed = transformed.replace(/require\((['"])([^'"]+\.ogg)\1\)/g, 'new URL("$2", import.meta.url).href')
      if (imports.length) transformed = `${imports.join("\n")}\n${transformed}`
      return transformed === code ? null : { code: transformed, map: null }
    },
  }
}

/** Transform .po gettext files into JSON-like JS exports for Angular i18n */
function poPlugin(): Plugin {
  return {
    name: "po-gettext-transform",
    transform(_code, id) {
      if (!id.endsWith(".po")) return null
      const fs = require("fs")
      const content = fs.readFileSync(id)
      const parsed = gettextParser.po.parse(content)
      return { code: `export default ${JSON.stringify(parsed)}`, map: null }
    },
  }
}

function renderPug(file: string): string {
  return pugCompiler.renderFile(file, {
    pretty: false,
    require: (asset: string) => readFileSync(path.resolve(path.dirname(file), asset), "utf8"),
  }).replace(/(#[A-Za-z][\w-]*)="\1"/g, '$1=""')
    .replace(/\btranslate="translate"/g, 'translate=""')
}

/** Inline Angular templates and styles that Vite does not process from decorator URLs. */
function angularResourcesPlugin(): Plugin {
  return {
    name: "angular-resources",
    enforce: "pre",
    transform(code, id) {
      if (id.endsWith(".pug")) {
        const html = renderPug(id)
        return { code: `export default ${JSON.stringify(html)}`, map: null }
      }
      if (!id.endsWith(".ts")) return null
      let transformed = code.replace(/templateUrl:\s*(['"])([^'"]+\.pug)\1/g, (_match, _quote, template) => {
        const html = renderPug(path.resolve(path.dirname(id), template))
        return `template: ${JSON.stringify(html)}`
      })
      const imports: string[] = []
      transformed = transformed.replace(/styleUrls:\s*\[([\s\S]*?)\]/g, (match, urls) => {
        const files = [...urls.matchAll(/(['"])([^'"]+)\1/g)].map((x: RegExpMatchArray) => x[2])
        if (!files.length) return match
        const styles = files.map((file: string) => {
          const name = `__componentStyle${imports.length}`
          imports.push(`import ${name} from ${JSON.stringify(`${file}?inline`)}`)
          return name
        })
        return `styles: [${styles.join(", ")}]`
      })
      if (imports.length) transformed = `${imports.join("\n")}\n${transformed}`
      return transformed === code ? null : { code: transformed, map: null }
    },
  }
}

export default defineConfig(({ mode }) => {
  if (mode === "main") {
    return defineMainConfig()
  }
  if (mode === "renderer") {
    return defineRendererConfig()
  }
  throw new Error(`Unsupported Vite config mode: ${mode}`)
})

function defineMainConfig(): UserConfig {
  return {
    root: path.resolve(__dirname, "./src/main"),
    build: {
      target: "esnext",
      outDir: path.resolve(__dirname, "./out/main"),
      emptyOutDir: true,
      sourcemap: true,
      lib: {
        entry: path.resolve(__dirname, "./src/main/index.ts"),
        formats: ["es"],
        fileName: () => "index.js",
      },
    },
    resolve: {
      dedupe: [
        "@angular/animations", "@angular/common", "@angular/compiler", "@angular/core",
        "@angular/forms", "@angular/platform-browser", "@angular/platform-browser-dynamic",
      ],
      alias: {
        "@": path.resolve(__dirname, "./src/main"),
      },
    },
    server: {
      forwardConsole: {
        unhandledErrors: true,
        logLevels: ['warn', 'error'],
      },
    },
  }
}


function defineRendererConfig(): UserConfig {
  return {
    root: path.resolve(__dirname, "./src/renderer"),
    // Disable Vite 8's built-in OXC TypeScript transform — SWC handles all TS via the plugin below.
    // Without this, OXC runs alongside SWC and double-transforms files, breaking type-only import
    // detection (OXC strips type info before Rolldown's module graph analysis).
    oxc: false,
    plugins: [
      nodeAddonPlugin(),
      assetRequirePlugin(),
      // SWC handles TypeScript with legacyDecorators + decoratorMetadata
      // required for Angular 15 JIT dependency injection
      swc.vite({
        jsc: {
          parser: {
            syntax: "typescript",
            decorators: true,
            tsx: false,
          },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
          },
          target: "es2020",
        },
        module: {
          type: "es6",
        },
      }),
      yaml(),
      angularResourcesPlugin(),
      poPlugin(),
    ],
    build: {
      outDir: path.resolve(__dirname, "./out/renderer"),
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        external: (id: string) => {
          // Externalize accidental Node.js built-in imports so they fail visibly in the sandbox.
          const nodeBuiltins = ["path", "fs", "fs/promises", "net", "crypto", "stream", "readline",
                                "os", "assert", "util", "constants", "events", "buffer", "url",
                                "querystring", "http", "https", "tls", "child_process", "dns",
                                "zlib", "dgram", "cluster", "worker_threads", "v8", "vm",
                                "perf_hooks", "async_hooks", "inspector", "module", "repl"]
          if (nodeBuiltins.includes(id) || id.startsWith("node:")) return true
          return false
        },
        // TypeScript interfaces are type-erased by SWC before Rolldown validates re-exports.
        // Suppress MISSING_EXPORT for these type-only symbols so the build succeeds.
        onwarn(warning, warn) {
          if (warning.code === 'MISSING_EXPORT') return
          warn(warning)
        },
      },
    },
    css: {
      preprocessorOptions: {
        scss: {
          // Allow SCSS @import to resolve from node_modules (webpack ~ compat)
          includePaths: [path.resolve(__dirname, "node_modules")],
          // Bypass package `exports` field restrictions so @import "ngx-toastr/..." resolves to disk
          importers: [{
            findFileUrl(url: string) {
              if (!url.startsWith("ngx-toastr/")) return null
              const file = path.resolve(__dirname, "node_modules", url)
              return new URL(`file://${file}`)
            },
          }],
        },
      },
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src/renderer"),
        // Alias for renderer-side generated IPC stubs, usable from packages/tabby-mobrowser
        "@gen": path.resolve(__dirname, "src/renderer/gen"),
        "tabby-core": path.resolve(__dirname, "src/renderer/packages/tabby-core"),
        "tabby-settings": path.resolve(__dirname, "src/renderer/packages/tabby-settings"),
        "tabby-terminal": path.resolve(__dirname, "src/renderer/packages/tabby-terminal"),
        "tabby-local": path.resolve(__dirname, "src/renderer/packages/tabby-local"),
        "tabby-ssh": path.resolve(__dirname, "src/renderer/packages/tabby-ssh"),
        "tabby-serial": path.resolve(__dirname, "src/renderer/packages/tabby-serial"),
        "tabby-telnet": path.resolve(__dirname, "src/renderer/packages/tabby-telnet"),
        "tabby-plugin-manager": path.resolve(__dirname, "src/renderer/packages/tabby-plugin-manager"),
        "tabby-linkifier": path.resolve(__dirname, "src/renderer/packages/tabby-linkifier"),
        "tabby-community-color-schemes": path.resolve(__dirname, "src/renderer/packages/tabby-community-color-schemes"),
        // tabby-mobrowser was written from scratch with src/ layout
        "tabby-mobrowser": path.resolve(__dirname, "src/renderer/packages/tabby-mobrowser/src"),
      },
    },
    // The optimizeDeps pre-bundler runs its own Rolldown instance and does not
    // inherit the plugins array. Register nodeAddonPlugin there too so pre-bundling
    // of packages that contain .node binaries (keytar, @serialport/*, etc.) succeeds.
    optimizeDeps: {
      exclude: ["@ng-bootstrap/ng-bootstrap", "windows-native-registry"],
      rolldownOptions: {
        plugins: [{
          name: "node-addon-files-in-deps",
          load(id: string) {
            if (id.endsWith(".node")) return "export default {}"
            return null
          },
        }],
      },
    },
    server: {
      forwardConsole: {
        unhandledErrors: true,
        logLevels: ['warn', 'error'],
      },
    },
  }
}
