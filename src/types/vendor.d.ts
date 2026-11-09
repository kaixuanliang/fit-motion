declare module '@mapbox/vector-tile' {
  export interface VectorTileFeature {
    type: number;
    properties: Record<string, unknown>;
    loadGeometry(): Array<Array<{ x: number; y: number }>>;
  }
  export interface VectorTileLayer {
    length: number;
    extent: number;
    feature(index: number): VectorTileFeature;
  }
  export class VectorTile {
    constructor(pbf: unknown);
    layers: Record<string, VectorTileLayer>;
  }
}

declare module 'pbf' {
  export default class Pbf {
    constructor(data: Uint8Array | ArrayBuffer);
  }
}
