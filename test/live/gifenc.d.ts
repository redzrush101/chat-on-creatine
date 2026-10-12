declare module 'gifenc' {
  type Palette = number[][];
  export function quantize(rgba: Uint8Array, maxColors: number): Palette;
  export function applyPalette(rgba: Uint8Array, palette: Palette): Uint8Array;
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, options: { palette: Palette; delay: number }): void;
    finish(): void;
    bytes(): Uint8Array;
  };
}
