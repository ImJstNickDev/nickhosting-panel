import { useEffect, useRef, useState } from 'react';

/** Parser work and requests belong to one mounted file, never to a global file cache. */
export function useViewerResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  dispose?: (value: T) => void,
) {
  const [result, setResult] = useState<{ key: string; value?: T; error?: unknown }>({ key });
  const operations = useRef({ load, dispose });
  operations.current = { load, dispose };
  useEffect(() => {
    const { load, dispose } = operations.current;
    const controller = new AbortController();
    let value: T | undefined;
    setResult({ key });
    void load(controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) {
          dispose?.(loaded);
          return;
        }
        value = loaded;
        setResult({ key, value });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key, error });
      });
    return () => {
      controller.abort();
      if (value !== undefined) dispose?.(value);
    };
  }, [key]);
  return result.key === key ? result : { key };
}
