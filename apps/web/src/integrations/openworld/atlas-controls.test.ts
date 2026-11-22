import { describe, expect, it, vi } from 'vitest';
import { AtlasCamera } from './atlas-camera.js';
import { AtlasPointerLock, canCaptureFlightKeyboard } from './atlas-pointer-lock.js';

function fixture() {
  const keyboard = {
    lock: vi.fn<(keys: string[]) => Promise<void>>().mockResolvedValue(undefined),
    unlock: vi.fn(),
  };
  const panel = { requestFullscreen: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) };
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: null as unknown,
    fullscreenEnabled: true,
    fullscreenElement: null as unknown,
    defaultView: { navigator: { keyboard } },
    exitFullscreen: vi.fn(async () => {
      doc.fullscreenElement = null;
      doc.dispatchEvent(new Event('fullscreenchange'));
    }),
    exitPointerLock: vi.fn(),
  });
  doc.exitPointerLock.mockImplementation(() => {
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
  });
  const canvas = {
    closest: () => panel,
    ownerDocument: doc,
    focus: vi.fn(),
    requestPointerLock: vi.fn<() => void | Promise<void>>(),
  };
  const notify = vi.fn();
  const notifyKeyboard = vi.fn();
  const lock = new AtlasPointerLock(canvas as unknown as HTMLCanvasElement, notify, notifyKeyboard);
  const fullscreen = () => {
    doc.fullscreenElement = panel;
    doc.dispatchEvent(new Event('fullscreenchange'));
  };
  const grant = () => {
    doc.pointerLockElement = canvas;
    doc.dispatchEvent(new Event('pointerlockchange'));
  };
  const deny = () => doc.dispatchEvent(new Event('pointerlockerror'));
  return { doc, canvas, notify, notifyKeyboard, keyboard, panel, fullscreen, lock, grant, deny };
}

describe('Openworld camera controls', () => {
  it('uses browser lock ownership, including native Escape, transient refusal and deliberate reacquisition', () => {
    const { doc, lock, grant, deny, notify, canvas } = fixture();
    lock.request();
    expect(lock.locked).toBe(false);
    grant();
    expect(lock.locked).toBe(true);
    expect(notify).toHaveBeenLastCalledWith('locked');
    doc.exitPointerLock();
    expect(notify).toHaveBeenLastCalledWith('idle');
    lock.request();
    deny();
    expect(lock.state).toBe('idle');
    lock.request();
    grant();
    expect(lock.locked).toBe(true);
    expect(canvas.requestPointerLock).toHaveBeenCalledTimes(3);
    lock.destroy();
    expect(doc.pointerLockElement).toBe(null);
  });
  it('waits for the change event before admitting input and stops as soon as ownership is lost', () => {
    const { doc, canvas, lock, grant, keyboard, fullscreen } = fixture();
    lock.request();
    doc.pointerLockElement = canvas;
    fullscreen();
    expect(lock.locked).toBe(false);
    expect(keyboard.lock).not.toHaveBeenCalled();
    grant();
    expect(lock.locked).toBe(true);
    doc.pointerLockElement = null;
    expect(lock.locked).toBe(false);
    doc.dispatchEvent(new Event('pointerlockchange'));
    lock.destroy();
  });
  it('rejects the initial warp to the origin, with free or pinned position and either delivery order', () => {
    const anchor = { clientX: 437.75, clientY: 471, screenX: 517.75, screenY: 511 };
    for (const pinned of [true, false]) {
      for (const early of [true, false]) {
        const { canvas, doc, lock, grant } = fixture();
        lock.request(anchor);
        doc.pointerLockElement = canvas;
        if (!early) grant();
        const position = pinned ? anchor : { clientX: 0, clientY: 0, screenX: 0, screenY: 0 };
        const warp = { ...position, movementX: -437, movementY: -471 } as MouseEvent;
        expect(lock.acceptsLook(warp)).toBe(false);
        if (early) grant();
        // A fast physical turn is still valid, even as the first real motion.
        expect(lock.acceptsLook({ ...warp, movementX: -600 })).toBe(true);
        expect(lock.acceptsLook(warp)).toBe(true);
        doc.pointerLockElement = null;
        expect(lock.acceptsLook(warp)).toBe(false);
        lock.destroy();
      }
    }
  });
  it('keeps the first real movement following acquisition with an expected keyboard-capture origin', () => {
    const { lock, grant } = fixture();
    const cursor = { clientX: 80, clientY: 220, screenX: 100, screenY: 250 };
    lock.acceptsLook({ ...cursor, movementX: 10, movementY: 5 } as MouseEvent);
    lock.request();
    grant();
    expect(lock.acceptsLook({ ...cursor, movementX: 0, movementY: 0 } as MouseEvent)).toBe(false);
    expect(lock.acceptsLook({ ...cursor, movementX: 1, movementY: -1 } as MouseEvent)).toBe(true);
    lock.destroy();
  });
  it('keeps drag/picking available after denial and releases a late grant when the route was torn down', async () => {
    const { doc, lock, grant, notify, canvas } = fixture();
    canvas.requestPointerLock.mockRejectedValueOnce(new Error('Not allowed'));
    lock.request();
    await Promise.resolve();
    expect(notify).toHaveBeenLastCalledWith('unavailable');
    lock.request();
    lock.destroy();
    grant();
    expect(doc.exitPointerLock).toHaveBeenCalledTimes(1);
    expect(doc.pointerLockElement).toBe(null);
    expect(notify).not.toHaveBeenCalledWith('locked');
  });
  it('requests pointer before fullscreen on the same gesture and only confirms real keyboard capture', async () => {
    const { lock, canvas, doc, grant, fullscreen, keyboard, panel, notifyKeyboard } = fixture();
    const order: string[] = [];
    canvas.requestPointerLock.mockImplementation(() => {
      order.push('pointer');
    });
    panel.requestFullscreen.mockImplementation(async () => {
      order.push('fullscreen');
    });
    lock.request();
    expect(order).toEqual(['pointer', 'fullscreen']);
    fullscreen();
    expect(keyboard.lock).not.toHaveBeenCalled();
    grant();
    expect(keyboard.lock).toHaveBeenCalledWith(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
    expect(lock.keyboardLocked).toBe(false);
    await Promise.resolve();
    expect(notifyKeyboard).toHaveBeenLastCalledWith(true);
    doc.exitPointerLock();
    expect(notifyKeyboard).toHaveBeenLastCalledWith(false);
    expect(keyboard.unlock).toHaveBeenCalledOnce();
    expect(doc.exitFullscreen).toHaveBeenCalledOnce();
    expect(lock.locked).toBe(false);
    lock.destroy();
  });
  it('releases both inputs when fullscreen ends before the pointer lock event', async () => {
    const { lock, grant, fullscreen, doc, keyboard, notifyKeyboard } = fixture();
    lock.request();
    grant();
    fullscreen();
    await Promise.resolve();
    await doc.exitFullscreen();
    expect(keyboard.unlock).toHaveBeenCalledOnce();
    expect(notifyKeyboard).toHaveBeenLastCalledWith(false);
    expect(doc.pointerLockElement).toBe(null);
    expect(doc.exitFullscreen).toHaveBeenCalledOnce();
    lock.destroy();
  });
  it('preserves manually opened map fullscreen and never requests or exits another element’s fullscreen', async () => {
    const { canvas, doc, lock, keyboard, panel, fullscreen, grant } = fixture();
    fullscreen();
    lock.request();
    grant();
    await Promise.resolve();
    lock.release();
    expect(keyboard.unlock).toHaveBeenCalledOnce();
    expect(panel.requestFullscreen).not.toHaveBeenCalled();
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
    doc.fullscreenElement = {};
    expect(canCaptureFlightKeyboard(canvas as unknown as HTMLCanvasElement)).toBe(false);
    lock.request();
    grant();
    expect(lock.locked).toBe(true);
    expect(lock.keyboardLocked).toBe(false);
    lock.destroy();
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
  });
  it('keeps mouse flight when keyboard permission is denied and does not retry until another gesture', async () => {
    const { lock, keyboard, fullscreen, grant, doc, notifyKeyboard } = fixture();
    keyboard.lock.mockRejectedValueOnce(new Error('Denied'));
    lock.request();
    grant();
    fullscreen();
    await Promise.resolve();
    doc.dispatchEvent(new Event('fullscreenchange'));
    expect(keyboard.lock).toHaveBeenCalledOnce();
    expect(notifyKeyboard).not.toHaveBeenCalled();
    expect(lock.locked).toBe(true);
    expect(lock.keyboardLocked).toBe(false);
    lock.destroy();
  });
  it('unlocks a pending keyboard permission request and ignores its late result', async () => {
    const { doc, lock, keyboard, fullscreen, grant, notifyKeyboard } = fixture();
    let confirm = () => {};
    keyboard.lock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
    );
    lock.request();
    grant();
    fullscreen();
    lock.destroy();
    confirm();
    await Promise.resolve();
    expect(notifyKeyboard).not.toHaveBeenCalled();
    expect(keyboard.unlock).toHaveBeenCalledOnce();
    expect(doc.fullscreenElement).toBe(null);
    expect(doc.pointerLockElement).toBe(null);
  });
  it('cleans up late fullscreen entry after release without disabling windowed flight on refusal', async () => {
    const { doc, lock, grant, fullscreen, panel, keyboard } = fixture();
    let confirm = () => {};
    panel.requestFullscreen.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
    );
    lock.request();
    grant();
    lock.release();
    fullscreen();
    confirm();
    await Promise.resolve();
    expect(doc.exitFullscreen).toHaveBeenCalledOnce();
    panel.requestFullscreen.mockRejectedValueOnce(new Error('Denied'));
    lock.request();
    grant();
    await Promise.resolve();
    expect(keyboard.lock).not.toHaveBeenCalled();
    expect(lock.locked).toBe(true);
    lock.destroy();
  });
  it('allows strafing and ascending next to a face edge without snapping a rotated eye back inside', () => {
    const camera = new AtlasCamera(300, { x: 8, z: 8, span: 160 });
    camera.width = 800;
    camera.height = 480;
    camera.setMode('fly');
    camera.look(-Math.PI / 2, 0);
    const eye = () => camera.ray(400, 240).origin;
    const start = eye();
    camera.move(0, 0, 1);
    expect(eye()[0]).toBeCloseTo(start[0], 8);
    expect(eye()[1]).toBeCloseTo(start[1] + 1, 8);
    expect(eye()[2]).toBeCloseTo(start[2], 8);
    camera.move(1, 0, 0);
    expect(Math.hypot(eye()[0] - start[0], eye()[2] - start[2])).toBeLessThanOrEqual(1.000001);
  });
});
