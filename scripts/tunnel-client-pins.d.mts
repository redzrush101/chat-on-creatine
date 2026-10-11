export interface TunnelClientTarget {
  readonly upstreamArch: string;
  readonly sha256: string;
}

export declare const TUNNEL_CLIENT: {
  readonly version: string;
  readonly targets: Readonly<Record<string, Readonly<Record<string, TunnelClientTarget>>>>;
};

export declare const UPSTREAM_OS: Readonly<Record<string, string>>;
