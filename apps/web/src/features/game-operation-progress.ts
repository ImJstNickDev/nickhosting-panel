interface Progress {
  state: string;
  effectState: string | null;
  fileTransfer?: { completedFiles: number; totalFiles: number };
}

export function gameProgressInterval(
  progress: Progress | undefined,
  connected: boolean,
  quickUntil?: number,
) {
  const unsettled = progress?.effectState === 'prepared' || progress?.effectState === 'uncertain';
  if (progress && !unsettled && ['succeeded', 'failed'].includes(progress.state)) return false;
  // File counters may change between public activity events.
  if (
    progress?.fileTransfer &&
    progress.fileTransfer.completedFiles < progress.fileTransfer.totalFiles
  )
    return 2000;
  if (connected) return 15000;
  if (quickUntil && Date.now() < quickUntil) return 500;
  return 3000;
}

/** Events carry no authority. Coalesce a burst, then reread; a hint received
 * during that read schedules one trailing check of the durable state. */
export function watchGameOperation(
  events: EventSource,
  serverId: string,
  operationId: string,
  connected: (value: boolean) => void,
  refresh: () => Promise<void>,
) {
  let closed = false;
  let pending = false;
  let reading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    if (closed) return;
    pending = true;
    if (reading || timer !== undefined) return;
    timer = setTimeout(async () => {
      timer = undefined;
      pending = false;
      reading = true;
      try {
        await refresh();
      } finally {
        reading = false;
        if (pending) schedule();
      }
    }, 32);
  }
  events.addEventListener('ready', () => {
    if (!closed) {
      connected(true);
      schedule();
    }
  });
  events.addEventListener('activity', (event: MessageEvent<string>) => {
    try {
      const value = JSON.parse(event.data);
      if (
        value?.serverId === serverId ||
        (value?.server_id === serverId && value.job_id === operationId)
      )
        schedule();
    } catch {
      // Periodic reads still recover from malformed or missed hints.
    }
  });
  events.onerror = () => {
    if (!closed) connected(false);
  };
  return () => {
    closed = true;
    clearTimeout(timer);
    events.close();
  };
}
