import * as fs from 'fs'
import * as path from 'path'
import wp from 'webpack'
import * as url from 'url'
import { createRequire } from 'module'
const __dirname = url.fileURLToPath(new URL('.', import.meta.url))
const _require = createRequire(import.meta.url)

import { AngularWebpackPlugin } from '@ngtools/webpack'
import { createEs2015LinkerPlugin } from '@angular/compiler-cli/linker/babel'
const linkerPlugin = createEs2015LinkerPlugin({
    linkerJitMode: true,
    fileSystem: {
        resolve: path.resolve,
        exists: fs.existsSync,
        dirname: path.dirname,
        relative: path.relative,
        readFile: fs.readFileSync,
    },
})

export default () => ({
    name: 'tabby',
    target: 'web',
    entry: {
        'index.ignore': 'file-loader?name=index.html!pug-html-loader!' + path.resolve(__dirname, './index.pug'),
        sentry: path.resolve(__dirname, 'lib/sentry.ts'),
        preload: path.resolve(__dirname, 'src/entry.preload.ts'),
        bundle: path.resolve(__dirname, 'src/entry.ts'),
    },
    mode: process.env.TABBY_DEV ? 'development' : 'production',
    optimization:{
        minimize: false,
    },
    context: __dirname,
    devtool: 'source-map',
    output: {
        path: path.join(__dirname, 'dist'),
        pathinfo: true,
        filename: '[name].js',
        publicPath: 'auto',
    },
    resolve: {
        modules: ['src/', 'node_modules', '../node_modules', 'assets/'].map(x => path.join(__dirname, x)),
        extensions: ['.ts', '.js'],
        fallback: {
            // Node.js built-ins not available in the sandboxed renderer.
            // resolve.fallback:false makes webpack bundle an empty {} stub instead of
            // generating require("X") which would throw "require is not defined" at runtime.
            // Pre-compiled tabby-* UMD bundles call these without try-catch in their
            // factories — stubs let the Angular modules load; runtime errors only occur
            // when the actual Node APIs are used (expected; migrate to IPC instead).
            assert: false,
            // buffer is provided as a real polyfill because the pre-compiled tabby-*
            // UMD bundles import it explicitly and Buffer is used at runtime in services.
            buffer: _require.resolve('buffer/'),
            child_process: false,
            constants: false,
            crypto: false,
            dns: false,
            domain: false,
            events: false,
            fs: false,
            'fs/promises': false,
            http: false,
            https: false,
            net: false,
            os: false,
            path: false,
            querystring: false,
            readline: false,
            stream: false,
            tls: false,
            tty: false,
            url: false,
            util: false,
            zlib: false,
            // node: prefix variants — same treatment as bare names above.
            // Must be in fallback (not externals) so webpack generates an inline
            // empty-stub module rather than a native require() call.
            'node:events': false,
            'node:fs': false,
            'node:path': false,
            'node:process': false,
            'node:stream': false,
            'node:url': false,
            'node:util': false,
        },
    },
    module: {
        rules: [
            {
                test: /\.(m?)js$/,
                loader: 'babel-loader',
                options: {
                    plugins: [linkerPlugin],
                    compact: false,
                    cacheDirectory: true,
                },
                resolve: {
                    fullySpecified: false,
                },
            },
            {
                test: /\.ts$/,
                use: {
                    loader: '@ngtools/webpack',
                },
            },
            { test: /\.scss$/, use: ['style-loader', 'css-loader', 'sass-loader'] },
            { test: /\.css$/, use: ['style-loader', 'css-loader', 'sass-loader'] },
            {
                test: /\.(png|svg|ttf|eot|otf|woff|woff2)(\?v=[0-9]\.[0-9]\.[0-9])?$/,
                type: 'asset',
            },
        ],
    },
    externals: {
        // Electron APIs — available in both the preload (Node context) and renderer (via
        // Electron's contextBridge/IPC) so they must remain externals, not fallbacks.
        '@electron/remote': 'commonjs @electron/remote',
        electron: 'commonjs electron',
        // These remain external because they are only ever accessed via the _require() guard
        // in plugins.ts (which returns null in the sandboxed renderer) — not at module init time.
        module: 'commonjs module',
        mz: 'commonjs mz',
        'v8-compile-cache': 'commonjs v8-compile-cache',
        // @xterm/addon-ligatures (and its dep font-finder) uses Node.js Buffer at module
        // scope and must not be bundled into the renderer. Provide an empty stub so that
        // LigaturesAddon resolves to undefined; the guard in xtermFrontend checks for it.
        '@xterm/addon-ligatures': 'Object.create(null)',
        // hexer calls util.inherits() at module scope — it is a Node.js-only debugging
        // tool used for hex dump output mode in TerminalStreamProcessor.
        hexer: 'Object.create(null)',
    },
    plugins: [
        new wp.DefinePlugin({
            // process.type is the only build-time constant kept here.
            // All other process.* values (platform, env.*) come from the preload via
            // contextBridge — see app/lib/sentry.ts and window.tabbyAPI.*.
            'process.type': '"renderer"',
        }),
        new AngularWebpackPlugin({
            tsconfig: path.resolve(__dirname, 'tsconfig.json'),
            directTemplateLoading: false,
            jitMode: true,
        })
    ],
})
