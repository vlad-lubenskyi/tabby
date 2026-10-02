// Derived from: tabby-ssh/src/algorithms.ts
import { SSHAlgorithmType } from './api'

export const supportedAlgorithms = {
    [SSHAlgorithmType.KEX]: [
        'mlkem768x25519-sha256',
        'curve25519-sha256',
        'curve25519-sha256@libssh.org',
        'diffie-hellman-group16-sha512',
        'diffie-hellman-group14-sha256',
        'diffie-hellman-group-exchange-sha256',
        'diffie-hellman-group-exchange-sha1',
        'diffie-hellman-group14-sha1',
        'diffie-hellman-group1-sha1',
        'ext-info-c',
        'ext-info-s',
        'kex-strict-c-v00@openssh.com',
        'kex-strict-s-v00@openssh.com',
    ],
    [SSHAlgorithmType.HOSTKEY]: [
        'ssh-ed25519',
        'ecdsa-sha2-nistp256',
        'ecdsa-sha2-nistp521',
        'rsa-sha2-256',
        'rsa-sha2-512',
        'ssh-rsa',
    ],
    [SSHAlgorithmType.CIPHER]: [
        'chacha20-poly1305@openssh.com',
        'aes256-gcm@openssh.com',
        'aes256-ctr',
        'aes192-ctr',
        'aes128-ctr',
        'aes256-cbc',
        'aes192-cbc',
        'aes128-cbc',
        '3des-cbc',
    ],
    [SSHAlgorithmType.HMAC]: [
        'hmac-sha2-512-etm@openssh.com',
        'hmac-sha2-256-etm@openssh.com',
        'hmac-sha2-512',
        'hmac-sha2-256',
        'hmac-sha1-etm@openssh.com',
        'hmac-sha1',
    ],
    [SSHAlgorithmType.COMPRESSION]: ['none', 'zlib@openssh.com', 'zlib'],
}

export const defaultAlgorithms = {
    [SSHAlgorithmType.KEX]: [
        'mlkem768x25519-sha256',
        'curve25519-sha256',
        'curve25519-sha256@libssh.org',
        'diffie-hellman-group16-sha512',
        'diffie-hellman-group14-sha256',
        'ext-info-c',
        'ext-info-s',
        'kex-strict-c-v00@openssh.com',
        'kex-strict-s-v00@openssh.com',
    ],
    [SSHAlgorithmType.HOSTKEY]: [
        'ssh-ed25519',
        'ecdsa-sha2-nistp256',
        'ecdsa-sha2-nistp521',
        'rsa-sha2-256',
        'rsa-sha2-512',
        'ssh-rsa',
    ],
    [SSHAlgorithmType.CIPHER]: [
        'chacha20-poly1305@openssh.com',
        'aes256-gcm@openssh.com',
        'aes256-ctr',
        'aes192-ctr',
        'aes128-ctr',
    ],
    [SSHAlgorithmType.HMAC]: [
        'hmac-sha2-512-etm@openssh.com',
        'hmac-sha2-256-etm@openssh.com',
        'hmac-sha2-512',
        'hmac-sha2-256',
        'hmac-sha1-etm@openssh.com',
        'hmac-sha1',
    ],
    [SSHAlgorithmType.COMPRESSION]: [
        'none',
    ],
}
