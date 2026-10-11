// Pinned openai/tunnel-client release. Read by src/main/tunnel/install.ts and scripts/fetch-tunnel-client.mjs.
export const TUNNEL_CLIENT = Object.freeze({
  version: 'v0.0.16',
  targets: Object.freeze({
    win32: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: 'edef7241b0c647fcb30f1a80ff376b6b25c51927960f257a3f01e21b17c2aba6' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'ecd748288b9bd9cc8f5a963855eb143f4788b831475156703d0bafdcd2dcb149' })
    }),
    darwin: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: '57b3dd73f2d042c7aeb5664681f7538078359f55538b9e048640f1df71a0c83f' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: 'a160820d45089b5253d8d671fe2a689bde0f73d78c135d1497a7b33f28a3ac62' })
    }),
    linux: Object.freeze({
      x64: Object.freeze({ upstreamArch: 'amd64', sha256: 'd60cdba019bce451bcc3a15478cc5b9cb11270b049f5b56ea39a80b517f8b117' }),
      arm64: Object.freeze({ upstreamArch: 'arm64', sha256: '963d0384aaa7c798778479c45673f9051a4039dd891aef8f8978d2a1a628b74f' })
    })
  })
});

/** Asset-name segment per Node platform. */
export const UPSTREAM_OS = Object.freeze({ win32: 'windows', darwin: 'darwin', linux: 'linux' });
