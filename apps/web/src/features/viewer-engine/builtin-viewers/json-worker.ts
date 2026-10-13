import { parseJsonTree } from './json-model.js';

self.onmessage = (event: MessageEvent<{ text: string; extension: string }>) => {
  try {
    self.postMessage({ tree: parseJsonTree(event.data.text, event.data.extension) });
  } catch (error) {
    self.postMessage({
      error: error instanceof RangeError ? 'viewer.jsonComplex' : 'viewer.jsonInvalid',
    });
  }
};
