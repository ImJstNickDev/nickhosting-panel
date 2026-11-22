/** All coordinates are metres on a single planetary face. Heights use the game's vertical datum. */
export type AtlasMode = 'plan' | 'iso' | 'fly';
export type AtlasView = { x: number; z: number; span: number };
export type AtlasBounds = { i0: number; j0: number; i1: number; j1: number };
export type AtlasFrame = AtlasView & {
  width: number;
  height: number;
  bounds: AtlasBounds;
  detailBounds?: AtlasBounds;
  yaw: number;
};
export type AtlasMaterial = {
  id: number;
  color: string;
  key?: string;
  plant?: boolean;
  liquid?: boolean;
  render?: string;
  tileMeters?: number;
  textured?: boolean;
};
export type AtlasRequest =
  | { kind: 'surface'; ci: number; cj: number; n: number; lod: number }
  | { kind: 'mesh'; i: number; j: number; lod: number }
  | { kind: 'seed'; x: number; y: number; z: number };
export type AtlasPoint = {
  x: number;
  z: number;
  y?: number;
  source: 'live' | 'indexed' | 'seed' | 'unknown';
  biome?: number;
};
export type AtlasPixel = { x: number; y: number; visible: boolean };
export type AtlasOptions = {
  face: number;
  edge: number;
  initialView: AtlasView;
  load: (request: AtlasRequest, signal: AbortSignal) => Promise<ArrayBuffer | null>;
  loadMeshes?: (
    requests: Extract<AtlasRequest, { kind: 'mesh' }>[],
    signal: AbortSignal,
  ) => Promise<(ArrayBuffer | null)[]>;
  loadTexture?: (id: number, signal: AbortSignal) => Promise<Blob | null>;
  onFrame?: () => void;
  onCamera?: (frame: AtlasFrame) => void;
  onPick?: (px: number, py: number, point: AtlasPoint) => void;
  onError?: (error: unknown) => void;
  onUnavailable?: () => void;
};
export type AtlasSeedStyle = 'surface' | 'biomes';
export interface AtlasController {
  setView(view: AtlasView): void;
  getView(): AtlasFrame;
  setMode(mode: AtlasMode): void;
  setCoverage(
    columns: readonly (readonly [number, number])[],
    stride?: number,
    auditedBounds?: AtlasBounds | null,
  ): void;
  setSurveyBounds(bounds: AtlasBounds | null): void;
  setPalette(materials: readonly AtlasMaterial[], voxelSize?: number): void;
  setSeed(
    enabled: boolean,
    style?: AtlasSeedStyle,
    biomes?: readonly { id: number; color: string }[],
    faceEdgeMeters?: number,
    maxZoom?: number,
  ): void;
  invalidate(cells: readonly (readonly [number, number])[] | null): void;
  zoom(factor: number): void;
  rotate(quarterTurns: number): void;
  move(right: number, forward: number, up?: number): void;
  mayNeedSeed(bounds: AtlasBounds, x: number, y: number, tileMetres: number): boolean;
  isSeedArea(x: number, z: number): boolean;
  project(x: number, z: number, y?: number): AtlasPixel;
  pick(px: number, py: number): AtlasPoint | null;
  retry(): void;
  destroy(): void;
}
