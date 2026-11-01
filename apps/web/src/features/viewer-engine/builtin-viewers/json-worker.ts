import { JsonTreeModel, jsonFailure } from './json-model.js';
import type { JsonRequest, JsonResponse } from './json-protocol.js';

let model: JsonTreeModel | undefined;
self.onmessage = (event: MessageEvent<JsonRequest & { requestId: number }>) => {
  const request = event.data;
  try {
    let result: Extract<JsonResponse, { result: unknown }>['result'];
    if (request.type === 'load') {
      model = undefined;
      model = new JsonTreeModel(request.text, request.extension);
      result = model.view();
    } else {
      if (!model) throw new Error('json_unloaded');
      switch (request.type) {
        case 'view':
          result = model.view(request.offset, request.limit);
          break;
        case 'action':
          result = model.action(request.action);
          break;
        case 'detail':
          result = model.detail(request.id, request.offset, request.limit);
          break;
        case 'copy':
          result = model.copy(request.id, request.kind);
          break;
      }
    }
    self.postMessage({ requestId: request.requestId, result } satisfies JsonResponse);
  } catch (error) {
    self.postMessage({
      requestId: request.requestId,
      error: jsonFailure(error),
    } satisfies JsonResponse);
  }
};
