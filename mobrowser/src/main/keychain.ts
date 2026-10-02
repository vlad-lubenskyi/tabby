// Derived from: app/lib/keytar.ts
import * as keytar from 'keytar'
import type { Empty } from './gen/google/protobuf/empty'
import type { StringValue } from './gen/google/protobuf/wrappers'
import type { KeychainService } from './gen/ipc_service'

export const keychainService: KeychainService = {
  async GetPassword({ service, account }) {
    const value = await keytar.getPassword(service, account)
    return { value: value ?? '' } as StringValue
  },

  async SetPassword({ service, account, password }) {
    await keytar.setPassword(service, account, password)
    return {} as Empty
  },

  async DeletePassword({ service, account }) {
    await keytar.deletePassword(service, account)
    return {} as Empty
  },
}
