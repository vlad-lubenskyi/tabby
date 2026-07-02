import { PluginInfo } from '../../tabby-core/src/api/mainProcess'
import { PLUGIN_BLACKLIST } from './pluginBlacklist'

// Node.js require is only available in non-sandboxed contexts (e.g. nodeIntegration:true dev builds).
// In the sandboxed renderer, this returns null for everything, and all plugin loading falls back
// to the webpack-bundled cachedBuiltinModules below.
function _require(mod: string): any {
    const nr: ((m: string) => any) | undefined = (global as any)['require']
    if (!nr) return null
    try { return nr(mod) } catch { return null }
}

function normalizePath (p: string): string {
    const cygwinPrefix = '/cygdrive/'
    if (p.startsWith(cygwinPrefix)) {
        p = p.substring(cygwinPrefix.length).replace('/', '\\')
        p = p[0] + ':' + p.substring(1)
    }
    return p
}

function getBuiltinPluginsPath(): string {
    const tabbyAPI = (window as any).tabbyAPI
    const path = _require('path')
    if (tabbyAPI?.devMode) {
        return path ? path.dirname(tabbyAPI?.appPath ?? '') : ''
    }
    return path ? path.join(tabbyAPI?.resourcesPath ?? '', 'builtin-plugins') : ''
}

// Webpack-bundled copies of shared Angular + tabby modules.
// These are served to dynamically-loaded plugins via the patched require() below,
// and are also used as a fallback when Node.js require is unavailable (sandboxed renderer).
const cachedBuiltinModules: Record<string, any> = {
    '@angular/animations': require('@angular/animations'),
    '@angular/cdk/drag-drop': require('@angular/cdk/drag-drop'),
    '@angular/cdk/clipboard': require('@angular/cdk/clipboard'),
    '@angular/common': require('@angular/common'),
    '@angular/compiler': require('@angular/compiler'),
    '@angular/core': require('@angular/core'),
    '@angular/forms': require('@angular/forms'),
    '@angular/localize': require('@angular/localize'),
    '@angular/localize/init': require('@angular/localize/init'),
    '@angular/platform-browser': require('@angular/platform-browser'),
    '@angular/platform-browser/animations': require('@angular/platform-browser/animations'),
    '@angular/platform-browser-dynamic': require('@angular/platform-browser-dynamic'),
    '@ng-bootstrap/ng-bootstrap': require('@ng-bootstrap/ng-bootstrap'),
    'ngx-toastr': require('ngx-toastr'),
    rxjs: require('rxjs'),
    'rxjs/operators': require('rxjs/operators'),
    'zone.js/dist/zone.js': require('zone.js'),
    'zone.js': require('zone.js'),
}

// Tabby built-in plugin packages bundled via webpack for the sandboxed renderer.
// Each must be a string literal so webpack can statically resolve and bundle the module.
// Try-catch isolates failures: the compiled UMD dist files call require("os") etc. at
// module scope, which throws in the sandboxed renderer — caught here so the rest of the
// app still loads. Failed packages are excluded from BUNDLED_BUILTIN_PLUGINS below.
try { cachedBuiltinModules['tabby-core'] = require('tabby-core') } catch (e) { console.warn('[plugins] Could not pre-load tabby-core:', e) } // eslint-disable-line
try { cachedBuiltinModules['tabby-settings'] = require('tabby-settings') } catch (e) { console.warn('[plugins] Could not pre-load tabby-settings:', e) } // eslint-disable-line
try { cachedBuiltinModules['tabby-terminal'] = require('tabby-terminal') } catch (e) { console.warn('[plugins] Could not pre-load tabby-terminal:', e) } // eslint-disable-line
try { cachedBuiltinModules['tabby-local'] = require('tabby-local') } catch (e) { console.warn('[plugins] Could not pre-load tabby-local:', e) } // eslint-disable-line
try { cachedBuiltinModules['tabby-electron'] = require('tabby-electron') } catch (e) { console.warn('[plugins] Could not pre-load tabby-electron:', e) } // eslint-disable-line

// Derived from what actually loaded above — used by findPlugins() in sandboxed mode.
const BUNDLED_BUILTIN_PLUGINS = ['tabby-core', 'tabby-settings', 'tabby-terminal', 'tabby-local', 'tabby-electron']
    .filter(name => !!cachedBuiltinModules[name])

const builtinModules = [
    ...Object.keys(cachedBuiltinModules),
    'tabby-core',
    'tabby-electron',
    'tabby-local',
    'tabby-settings',
    'tabby-terminal',
]

// Intercept global.require (only available with nodeIntegration:true) to transparently serve
// bundled versions of shared modules so dynamically-loaded plugins don't double-bundle them.
const originalRequire = (global as any).require
if (originalRequire) {
    ;(global as any).require = function (query: string) {
        if (cachedBuiltinModules[query]) {
            return cachedBuiltinModules[query]
        }
        return originalRequire.apply(this, [query])
    }

    const nodeModule = _require('module')
    if (nodeModule) {
        const originalModuleRequire = nodeModule.prototype.require
        nodeModule.prototype.require = function (query: string) {
            if (cachedBuiltinModules[query]) {
                return cachedBuiltinModules[query]
            }
            return originalModuleRequire.call(this, query)
        }
    }
}

export type ProgressCallback = (current: number, total: number) => void

export function initModuleLookup (userPluginsPath: string): void {
    const nodeModule = _require('module')
    if (!nodeModule) return

    const path = _require('path')
    if (!path) return

    const tabbyAPI = (window as any).tabbyAPI
    const builtinPluginsPath = getBuiltinPluginsPath()
    const nodeRequire: ((m: string) => any) | undefined = (global as any)['require']

    global['module'].paths.map((x: string) => nodeModule.globalPaths.push(normalizePath(x)))

    const paths = []
    paths.unshift(path.join(userPluginsPath, 'node_modules'))
    paths.unshift(path.join(tabbyAPI.appPath, 'node_modules'))

    if (tabbyAPI?.devMode) {
        paths.unshift(path.dirname(tabbyAPI.appPath))
    }

    paths.unshift(builtinPluginsPath)
    if (tabbyAPI?.tabbyPlugins) {
        tabbyAPI.tabbyPlugins.split(':').map(x => paths.push(normalizePath(x)))
    }

    process.env.NODE_PATH += path.delimiter + paths.join(path.delimiter)
    nodeModule._initPaths()

    if (nodeRequire) {
        builtinModules.forEach(m => {
            if (!cachedBuiltinModules[m]) {
                cachedBuiltinModules[m] = nodeRequire(m)
            }
        })
    }
}

const PLUGIN_PREFIX = 'tabby-'
const LEGACY_PLUGIN_PREFIX = 'terminus-'

async function getCandidateLocationsInPluginDir (pluginDir: any): Promise<{ pluginDir: string, packageName: string }[]> {
    const fs = _require('mz/fs')
    const path = _require('path')
    if (!fs || !path) return []

    const candidateLocations: { pluginDir: string, packageName: string }[] = []

    if (await fs.exists(pluginDir)) {
        const pluginNames = await fs.readdir(pluginDir)
        if (await fs.exists(path.join(pluginDir, 'package.json'))) {
            candidateLocations.push({
                pluginDir: path.dirname(pluginDir),
                packageName: path.basename(pluginDir),
            })
        }

        const promises = []

        for (const packageName of pluginNames) {
            if ((packageName.startsWith(PLUGIN_PREFIX) || packageName.startsWith(LEGACY_PLUGIN_PREFIX)) && !PLUGIN_BLACKLIST.includes(packageName)) {
                const pluginPath = path.join(pluginDir, packageName)
                const infoPath = path.join(pluginPath, 'package.json')
                promises.push(fs.exists(infoPath).then(result => {
                    if (result) {
                        candidateLocations.push({ pluginDir, packageName })
                    }
                }))
            }
        }

        await Promise.all(promises)
    }

    return candidateLocations
}

async function getPluginCandidateLocation (paths: any): Promise<{ pluginDir: string, packageName: string }[]> {
    const candidateLocationsPromises: Promise<{ pluginDir: string, packageName: string }[]>[] = []

    const processedPaths = []

    for (let pluginDir of paths) {
        if (processedPaths.includes(pluginDir)) {
            continue
        }
        processedPaths.push(pluginDir)

        pluginDir = normalizePath(pluginDir)

        candidateLocationsPromises.push(getCandidateLocationsInPluginDir(pluginDir))

    }

    const candidateLocations: { pluginDir: string, packageName: string }[] = []
    for (const pluginCandidateLocations of await Promise.all(candidateLocationsPromises)) {
        candidateLocations.push(...pluginCandidateLocations)
    }

    return candidateLocations
}

async function parsePluginInfo (pluginDir: string, packageName: string): Promise<PluginInfo|null> {
    const fs = _require('mz/fs')
    const path = _require('path')
    if (!fs || !path) return null

    const builtinPluginsPath = getBuiltinPluginsPath()
    const pluginPath = path.join(pluginDir, packageName)
    const infoPath = path.join(pluginPath, 'package.json')

    const name = packageName.startsWith(PLUGIN_PREFIX) ? packageName.substring(PLUGIN_PREFIX.length) : packageName.substring(LEGACY_PLUGIN_PREFIX.length)

    try {
        const info = JSON.parse(await fs.readFile(infoPath, { encoding: 'utf-8' }))

        if (!info.keywords || !(info.keywords.includes('terminus-plugin') || info.keywords.includes('terminus-builtin-plugin') || info.keywords.includes('tabby-plugin') || info.keywords.includes('tabby-builtin-plugin'))) {
            return null
        }

        let author = info.author
        author = author.name || author

        console.log(`Found ${name} in ${pluginDir}`)

        return {
            name: name,
            packageName: packageName,
            isBuiltin: pluginDir === builtinPluginsPath,
            isLegacy: info.keywords.includes('terminus-plugin') || info.keywords.includes('terminus-builtin-plugin'),
            version: info.version,
            description: info.description,
            author,
            path: pluginPath,
            info,
        }
    } catch (error) {
        console.error('Cannot load package info for', packageName)
        return null
    }
}

export async function findPlugins (): Promise<PluginInfo[]> {
    const nodeModule = _require('module')
    const nodeRequire: ((m: string) => any) | undefined = (global as any)['require']

    // Sandboxed renderer: no Node.js require available.
    // Return the webpack-bundled built-ins so Angular can bootstrap.
    if (!nodeRequire || !nodeModule) {
        return BUNDLED_BUILTIN_PLUGINS.map(packageName => ({
            name: packageName.replace(PLUGIN_PREFIX, ''),
            packageName,
            isBuiltin: true,
            isLegacy: false,
            version: '0.0.0',
            description: '',
            author: '',
            path: packageName,
            info: {},
        }))
    }

    const paths = nodeModule.globalPaths
    let foundPlugins: PluginInfo[] = []

    const candidateLocations: { pluginDir: string, packageName: string }[] = await getPluginCandidateLocation(paths)

    const builtinPluginsPath = getBuiltinPluginsPath()
    const foundPluginsPromises: Promise<PluginInfo|null>[] = []
    for (const { pluginDir, packageName } of candidateLocations) {

        if (builtinModules.includes(packageName) && pluginDir !== builtinPluginsPath) {
            continue
        }

        foundPluginsPromises.push(parsePluginInfo(pluginDir, packageName))
    }

    for (const pluginInfo of await Promise.all(foundPluginsPromises)) {
        if (pluginInfo) {
            const existing = foundPlugins.find(x => x.name === pluginInfo.name)
            if (existing) {
                if (existing.isLegacy) {
                    console.info(`Plugin ${pluginInfo.packageName} already exists, overriding`)
                    foundPlugins = foundPlugins.filter(x => x.name !== pluginInfo.name)
                } else {
                    console.info(`Plugin ${pluginInfo.packageName} already exists, skipping`)
                    continue
                }
            }

            foundPlugins.push(pluginInfo)
        }
    }

    foundPlugins.sort((a, b) => a.name > b.name ? 1 : -1)
    foundPlugins.sort((a, b) => a.isBuiltin < b.isBuiltin ? 1 : -1)
    return foundPlugins
}

export async function loadPlugins (foundPlugins: PluginInfo[], progress: ProgressCallback): Promise<any[]> {
    const nodeRequire: ((m: string) => any) | undefined = (global as any)['require']

    const plugins: any[] = []
    const pluginsPromises: Promise<any>[] = []

    let index = 0
    const setProgress = function () {
        index++
        progress(index, foundPlugins.length)
    }

    progress(0, 1)
    for (const foundPlugin of foundPlugins) {
        pluginsPromises.push(new Promise(x => {
            // Prefer webpack-bundled cache; fall back to Node.js require for user-installed plugins.
            const packageModule = cachedBuiltinModules[foundPlugin.packageName]
                ?? (nodeRequire ? (() => {
                    try {
                        console.info(`Loading ${foundPlugin.name}: ${(nodeRequire as any).resolve(foundPlugin.path)}`)
                        return nodeRequire(foundPlugin.path)
                    } catch (error) {
                        console.error(`Could not load ${foundPlugin.name}:`, error)
                        return null
                    }
                })() : null)

            if (packageModule) {
                try {
                    if (foundPlugin.packageName.startsWith('tabby-')) {
                        cachedBuiltinModules[foundPlugin.packageName.replace('tabby-', 'terminus-')] = packageModule
                    }
                    const pluginModule = packageModule.default?.forRoot ? packageModule.default.forRoot() : packageModule.default
                    pluginModule.pluginName = foundPlugin.name
                    pluginModule.bootstrap = packageModule.bootstrap
                    plugins.push(pluginModule)
                } catch (error) {
                    console.error(`Could not initialise ${foundPlugin.name}:`, error)
                }
            } else {
                console.warn(`Skipping ${foundPlugin.name}: module not available`)
            }

            setProgress()
            setTimeout(x, 50)
        }))
    }
    await Promise.all(pluginsPromises)

    progress(1, 1)
    return plugins
}
