import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlayerXpBar } from '../../src/integrations/minecraft/player-xp-bar.js';

function texture(center: string, left: string, right: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 182;
  canvas.height = 5;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Missing fixture context');
  context.fillStyle = center;
  context.fillRect(0, 0, 182, 5);
  context.fillStyle = left;
  context.fillRect(0, 0, 1, 5);
  context.fillStyle = right;
  context.fillRect(181, 0, 1, 5);
  return canvas.toDataURL();
}
const background = texture('#333333', '#ff0000', '#0000ff');
const foreground = texture('#00ff00', '#ffff00', '#00ffff');
function Fixture() {
  const [progress, setProgress] = useState(0);
  const [width, setWidth] = useState(600);
  return (
    <>
      <style>{`.minecraft-players {container-type:inline-size} .xp-frame {position:relative;width:350px;height:10px;--minecraft-xp-pixel:2px} @container(max-width:480px){.xp-frame{--minecraft-xp-pixel:1.5px}}`}</style>
      <button type="button" onClick={() => setProgress(0)}>
        Zero
      </button>
      <button type="button" onClick={() => setProgress(0.5)}>
        Half
      </button>
      <button type="button" onClick={() => setProgress(1)}>
        Full
      </button>
      <button type="button" onClick={() => setWidth(460)}>
        Narrow
      </button>
      <div className="minecraft-players" style={{ width }}>
        <div className="xp-frame">
          <PlayerXpBar progress={progress} background={background} foreground={foreground} />
        </div>
      </div>
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(<Fixture />);
