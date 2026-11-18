import { minecraftUiModule } from '@nickhosting/minecraft/ui';
import { useEffect, useState } from 'react';

// The same optional, locally prepared client font is shared by native previews.
const assets = minecraftUiModule.assets ?? {};
let fontRequest: Promise<boolean> | undefined;
function prepareFont() {
  if (!assets.gatewayFont || typeof FontFace === 'undefined') return Promise.resolve(false);
  fontRequest ??= new FontFace('MinecraftPreview', `url(${JSON.stringify(assets.gatewayFont)})`)
    .load()
    .then((font) => {
      document.fonts.add(font);
      return true;
    })
    // A source checkout without locally supplied Mojang resources remains editable.
    .catch(() => false);
  return fontRequest;
}
export function useMinecraftFont() {
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    let active = true;
    void prepareFont().then((ready) => {
      if (active) setFontReady(ready);
    });
    return () => {
      active = false;
    };
  }, []);
  return fontReady;
}
