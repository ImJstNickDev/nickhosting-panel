/** Local integration artwork only; registering a mark does not enable its runtime. */
export const minecraftRuntimeLogos = {
  'runtime-vanilla': new URL('./assets/runtime-logos/vanilla.png', import.meta.url).href,
  'runtime-fabric': new URL('./assets/runtime-logos/fabric.png', import.meta.url).href,
  'runtime-forge': new URL('./assets/runtime-logos/forge.png', import.meta.url).href,
  'runtime-paper': new URL('./assets/runtime-logos/paper.png', import.meta.url).href,
  'runtime-folia': new URL('./assets/runtime-logos/folia.png', import.meta.url).href,
  'runtime-neoforge': new URL('./assets/runtime-logos/neoforge.png', import.meta.url).href,
  'runtime-quilt': new URL('./assets/runtime-logos/quilt.svg', import.meta.url).href,
  'runtime-purpur': new URL('./assets/runtime-logos/purpur.png', import.meta.url).href,
  'runtime-pufferfish': new URL('./assets/runtime-logos/pufferfish.svg', import.meta.url).href,
  'runtime-arclight': new URL('./assets/runtime-logos/arclight.jpeg', import.meta.url).href,
};

export function minecraftRuntimeArtwork(runtime: string) {
  const assetId = `runtime-${runtime}`;
  return Object.hasOwn(minecraftRuntimeLogos, assetId)
    ? {
        assetId,
        presentation: 'icon' as const,
        tone: runtime === 'forge' ? ('dark' as const) : ('light' as const),
      }
    : undefined;
}
