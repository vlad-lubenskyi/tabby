import { ConfigProvider } from './api/configProvider'
import { Platform } from './api/hostApp'
import configDefaultsYaml from './configDefaults.yaml'
import configDefaultsMacos from './configDefaults.macos.yaml'
import configDefaultsWindows from './configDefaults.windows.yaml'
import configDefaultsLinux from './configDefaults.linux.yaml'
import configDefaultsWeb from './configDefaults.web.yaml'

/** @hidden */
export class CoreConfigProvider extends ConfigProvider {
    platformDefaults = {
        [Platform.macOS]: configDefaultsMacos,
        [Platform.Windows]: configDefaultsWindows,
        [Platform.Linux]: configDefaultsLinux,
        [Platform.Web]: configDefaultsWeb,
    }

    defaults = configDefaultsYaml
}
