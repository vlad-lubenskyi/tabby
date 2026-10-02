// Derived from: app/src/entry.ts
import '@angular/compiler' // must be first — loads JIT compiler before any Angular decorators are processed
import 'zone.js'
import 'reflect-metadata'
import 'source-sans-pro/source-sans-pro.css'
import 'source-code-pro/source-code-pro.css'
import '@fortawesome/fontawesome-free/css/solid.css'
import '@fortawesome/fontawesome-free/css/brands.css'
import '@fortawesome/fontawesome-free/css/regular.css'
import '@fortawesome/fontawesome-free/css/fontawesome.css'
import './preload.scss'
import './global.scss'

import { enableProdMode, ApplicationRef } from '@angular/core'
import { enableDebugTools } from '@angular/platform-browser'
import { platformBrowserDynamic } from '@angular/platform-browser-dynamic'

import { BOOTSTRAP_DATA, bootstrap as AppRootComponent } from 'tabby-core'
import { getRootModule } from './app.module'
import { ipc } from './gen/ipc'
import { AppConfigService } from './packages/tabby-mobrowser/src/services/appConfig.service'

// Import all plugin modules statically (no runtime discovery)
// The aliases in vite.config.ts map 'tabby-*' → packages/tabby-*/
// tabby-mobrowser points to packages/tabby-mobrowser/src/ (has its own src/ layout)
import TabbyCoreModule from 'tabby-core'
import TabbySettingsModule from 'tabby-settings'
import TabbyTerminalModule from 'tabby-terminal'
import TabbyLocalModule from 'tabby-local'
import TabbyMoBrowserModule from 'tabby-mobrowser'
import TabbySSHModule from 'tabby-ssh'
import TabbySerialModule from 'tabby-serial'
import TabbyTelnetModule from 'tabby-telnet'
import TabbyPluginManagerModule from 'tabby-plugin-manager'
import TabbyLinkifierModule from 'tabby-linkifier'

// Always start at the default hash
location.hash = ''

async function bootstrap() {
    // Load bootstrap data from the MoBrowser app service
    const appConfig = new AppConfigService()
    await appConfig.load()

    const bootstrapData = appConfig.data

    if (bootstrapData.devMode) {
        console.warn('Running in debug mode')
    } else {
        enableProdMode()
    }

    // Build a tabby-core compatible BootstrapData from IPC data
    const tabbyCoreBootstrap = {
        config: {},
        executable: bootstrapData.exePath,
        isMainWindow: true,
        windowID: 0,
        installedPlugins: bootstrapData.installedPlugins.map(name => ({
            name,
            description: '',
            packageName: name,
            isBuiltin: true,
            isLegacy: false,
            version: bootstrapData.appVersion,
            author: '',
        })),
        userPluginsPath: bootstrapData.userPluginsPath,
    }

    // Load raw config YAML so tabby-core can parse it
    try {
        const result = await ipc.fs.ReadFile({ path: bootstrapData.userDataPath + '/config.yaml' })
        const yamlContent = new TextDecoder().decode(result.data as Uint8Array)
        ;(tabbyCoreBootstrap as any).rawConfig = yamlContent
    } catch {
        // No config file yet — fine, use defaults
    }

    const plugins = [
        TabbyCoreModule.forRoot(),
        TabbySettingsModule,
        TabbyTerminalModule,
        TabbyLocalModule,
        TabbyMoBrowserModule,
        TabbySSHModule,
        TabbySerialModule,
        TabbyTelnetModule,
        TabbyPluginManagerModule,
        TabbyLinkifierModule,
        // ponytail: re-enable community schemes when their asset directory is copied into this standalone app.
    ]
    window['pluginModules'] = plugins

    const module = getRootModule(plugins, AppRootComponent, [
        { provide: AppConfigService, useValue: appConfig },
    ])

    const moduleRef = await platformBrowserDynamic([
        { provide: BOOTSTRAP_DATA, useValue: tabbyCoreBootstrap },
    ]).bootstrapModule(module)

    if (bootstrapData.devMode) {
        const applicationRef = moduleRef.injector.get(ApplicationRef)
        const componentRef = applicationRef.components[0]
        enableDebugTools(componentRef)
    }

    return moduleRef
}

bootstrap().catch(err => {
    console.error('Bootstrap failed:', err)
})
