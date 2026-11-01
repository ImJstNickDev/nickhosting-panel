import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MinecraftPlayerBody } from '../../src/integrations/minecraft/player-body.js';

function Fixture() {
  const [active, setActive] = useState<string[]>([]);
  const [mounted, setMounted] = useState(true);
  const [uuid, setUuid] = useState('11111111-1111-4111-8111-111111111111');
  return (
    <>
      <button type="button" onClick={() => setMounted(!mounted)}>
        Toggle mount
      </button>
      <button type="button" onClick={() => setActive(['first', 'second'])}>
        Activate both
      </button>
      <button type="button" onClick={() => setUuid('33333333-3333-4333-8333-333333333333')}>
        Change player
      </button>
      <div style={{ display: 'flex', gap: 30, marginTop: 30 }}>
        {mounted &&
          ['first', 'second'].map((name, index) => (
            <button
              key={name}
              type="button"
              aria-label={name}
              onMouseEnter={() => setActive([name])}
              onMouseLeave={() => setActive([])}
              onFocus={() => setActive([name])}
              onBlur={() => setActive([])}
            >
              <MinecraftPlayerBody
                name={name}
                uuid={index ? '22222222-2222-4222-8222-222222222222' : uuid}
                active={active.includes(name)}
                variant={index === 0 ? 'bust' : 'full'}
              />
            </button>
          ))}
      </div>
      <div style={{ height: 1800 }} />
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(<Fixture />);
