import type { AtlasFlightLock, AtlasPointerPosition } from './atlas-types.js';

type FlightKeyboard = { lock(keys: string[]): Promise<void>; unlock(): void };
type KeyboardSession = {
  panel: HTMLElement;
  keyboard: FlightKeyboard;
  entered: boolean;
  capture: 'idle' | 'requested' | 'denied';
};

// Request the physical flight keys so Chromium can deliver Ctrl+W, Ctrl+S, etc.
// Escape stays browser-owned and immediately releases capture.
const flightKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'];
const fullscreenOwners = new WeakMap<HTMLElement, KeyboardSession>();
function keyboardTarget(canvas: HTMLCanvasElement) {
  const doc = canvas.ownerDocument;
  if (!doc.fullscreenEnabled) return;
  const panel = canvas.closest<HTMLElement>('.ow-panel');
  const navigator = doc.defaultView?.navigator as
    | (Navigator & { keyboard?: FlightKeyboard })
    | undefined;
  const keyboard = navigator?.keyboard;
  if (
    !panel ||
    typeof panel.requestFullscreen !== 'function' ||
    typeof keyboard?.lock !== 'function' ||
    typeof keyboard.unlock !== 'function'
  )
    return;
  if (doc.fullscreenElement && doc.fullscreenElement !== panel) return;
  return { panel, keyboard };
}

export function canCaptureFlightKeyboard(canvas: HTMLCanvasElement) {
  return !!keyboardTarget(canvas);
}

/** Only the browser can confirm acquisition, denial or release through its own Escape gesture. */
export class AtlasPointerLock {
  state: AtlasFlightLock;
  keyboardLocked = false;
  private session?: KeyboardSession;
  private lastCursor?: AtlasPointerPosition;
  private lookOrigin?: AtlasPointerPosition;
  private pending = false;
  private wanted = false;
  private disposed = false;
  private lastRelease = -Infinity;
  private readonly document: Document;
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly notify: (state: AtlasFlightLock) => void,
    private readonly notifyKeyboard?: (active: boolean) => void,
  ) {
    this.document = canvas.ownerDocument;
    this.state = typeof canvas.requestPointerLock === 'function' ? 'idle' : 'unavailable';
    this.document.addEventListener('pointerlockchange', this.change);
    this.document.addEventListener('pointerlockerror', this.denied);
    this.document.addEventListener('fullscreenchange', this.fullscreenChange);
    if (this.state === 'unavailable') notify(this.state);
  }
  get locked() {
    // Chromium can recenter the cursor after assigning the element, before its change event.
    return (
      !this.pending &&
      this.state === 'locked' &&
      this.wanted &&
      this.document.pointerLockElement === this.canvas
    );
  }
  private publish(value: AtlasFlightLock) {
    if (this.state === value) return;
    this.state = value;
    if (!this.disposed) this.notify(value);
  }
  acceptsLook(event: MouseEvent) {
    if (!this.wanted) {
      this.lastCursor = event;
      return false;
    }
    if (!this.locked || (!event.movementX && !event.movementY)) return false;
    const origin = this.lookOrigin;
    if (!origin) return true;
    this.lookOrigin = undefined;
    // On capture Chromium may report a physical warp to (0,0) as its first delta.
    // Some implementations pin absolute coordinates to the pre-lock position. Match
    // that one displacement, allowing fractional CSS coordinates on the gesture.
    const warped = (x: number, y: number, previousX: number, previousY: number) =>
      Math.abs(event.movementX + previousX) < 1 &&
      Math.abs(event.movementY + previousY) < 1 &&
      ((x === 0 && y === 0) || (Math.abs(x - previousX) < 1 && Math.abs(y - previousY) < 1));
    return (
      !warped(event.clientX, event.clientY, origin.clientX, origin.clientY) &&
      !warped(event.screenX, event.screenY, origin.screenX, origin.screenY)
    );
  }
  request(gesture?: AtlasPointerPosition) {
    if (this.disposed || this.pending || this.locked) return;
    if (typeof this.canvas.requestPointerLock !== 'function') return;
    this.lookOrigin = gesture ?? this.lastCursor;
    this.lastCursor = undefined;
    this.pending = true;
    this.wanted = true;
    this.canvas.focus({ preventScroll: true });
    try {
      // Fullscreen consumes the click's user activation. Request pointer lock first,
      // without awaiting either API. Older browsers return void and dispatch events.
      this.canvas.requestPointerLock()?.catch(this.denied);
    } catch {
      this.denied();
      return;
    }
    const target = keyboardTarget(this.canvas);
    if (!target || !this.wanted) return;
    const session: KeyboardSession = {
      ...target,
      entered: this.document.fullscreenElement === target.panel,
      capture: 'idle',
    };
    this.session = session;
    if (session.entered) {
      // An earlier atlas may still be releasing this panel while its replacement mounts.
      // Fullscreen opened by the user has no owner and must survive programmatic release.
      if (fullscreenOwners.has(session.panel)) fullscreenOwners.set(session.panel, session);
      this.tryKeyboard();
      return;
    }
    fullscreenOwners.set(session.panel, session);
    try {
      session.panel.requestFullscreen().then(
        () => {
          if (this.session === session) this.fullscreenChange();
          else {
            this.exitOwnedFullscreen(session);
            if (fullscreenOwners.get(session.panel) === session)
              fullscreenOwners.delete(session.panel);
          }
        },
        () => this.fullscreenDenied(session),
      );
    } catch {
      this.fullscreenDenied(session);
    }
  }
  private fullscreenDenied(session: KeyboardSession) {
    if (fullscreenOwners.get(session.panel) === session) fullscreenOwners.delete(session.panel);
    if (this.session === session) this.session = undefined;
  }
  private fullscreenChange = () => {
    const session = this.session;
    if (!session) return;
    if (this.document.fullscreenElement === session.panel) {
      session.entered = true;
      this.tryKeyboard();
    } else if (session.entered) this.release();
  };
  private tryKeyboard() {
    const session = this.session;
    if (
      session?.capture !== 'idle' ||
      !this.locked ||
      this.document.fullscreenElement !== session.panel
    )
      return;
    session.capture = 'requested';
    try {
      session.keyboard.lock(flightKeys).then(
        () => {
          if (
            this.session !== session ||
            !this.locked ||
            this.document.fullscreenElement !== session.panel
          )
            return;
          this.keyboardLocked = true;
          this.notifyKeyboard?.(true);
        },
        () => {
          // Fullscreen/pointer lock can still provide flight with Q for descent.
          session.capture = 'denied';
        },
      );
    } catch {
      session.capture = 'denied';
    }
  }
  private exitOwnedFullscreen(session: KeyboardSession) {
    if (fullscreenOwners.get(session.panel) !== session) return;
    if (this.document.fullscreenElement !== session.panel) {
      // A requested fullscreen may still be in flight. Its resolution also checks ownership.
      if (session.entered) fullscreenOwners.delete(session.panel);
      return;
    }
    fullscreenOwners.delete(session.panel);
    void this.document.exitFullscreen().catch(() => {});
  }
  private endKeyboard() {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    if (session.capture === 'requested') session.keyboard.unlock();
    if (this.keyboardLocked) {
      this.keyboardLocked = false;
      if (!this.disposed) this.notifyKeyboard?.(false);
    }
    this.exitOwnedFullscreen(session);
  }
  private change = () => {
    if (this.document.pointerLockElement === this.canvas) {
      this.pending = false;
      if (this.wanted) {
        this.publish('locked');
        this.tryKeyboard();
      } else this.document.exitPointerLock();
    } else if (this.state === 'locked') {
      this.lastRelease = performance.now();
      this.wanted = false;
      this.endKeyboard();
      this.publish('idle');
    }
    if (this.disposed && !this.pending) this.unsubscribe();
  };
  private denied = () => {
    if (!this.pending) return;
    this.pending = false;
    // Browsers can briefly refuse reacquisition after their Escape gesture.
    if (this.wanted)
      this.publish(performance.now() - this.lastRelease < 2000 ? 'idle' : 'unavailable');
    this.wanted = false;
    this.endKeyboard();
    if (this.disposed) this.unsubscribe();
  };
  release() {
    this.wanted = false;
    this.endKeyboard();
    if (this.document.pointerLockElement === this.canvas) this.document.exitPointerLock();
  }
  private unsubscribe() {
    this.document.removeEventListener('pointerlockchange', this.change);
    this.document.removeEventListener('pointerlockerror', this.denied);
    this.document.removeEventListener('fullscreenchange', this.fullscreenChange);
  }
  destroy() {
    this.disposed = true;
    this.release();
    // A pending browser grant may arrive after route teardown. Release it if it does.
    if (!this.pending) this.unsubscribe();
  }
}
