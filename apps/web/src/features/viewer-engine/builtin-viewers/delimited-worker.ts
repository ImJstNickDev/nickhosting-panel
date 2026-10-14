import { DelimitedModel } from './delimited-model.js';
import {
  DelimitedError,
  type DelimitedRequest,
  type DelimitedResponse,
} from './delimited-protocol.js';

let model: DelimitedModel | undefined;
self.onmessage = (event: MessageEvent<DelimitedRequest & { requestId: number }>) => {
  const request = event.data;
  try {
    let result: Extract<DelimitedResponse, { result: unknown }>['result'];
    if (request.type === 'load') {
      model = undefined;
      model = new DelimitedModel(request.text, request.extension, request.options);
      result = model.view();
    } else {
      if (!model) throw new DelimitedError('invalid');
      switch (request.type) {
        case 'view':
          result = model.view(request.view);
          break;
        case 'detail':
          result = model.detail(request.rowId, request.column, request.revision);
          break;
        case 'edit':
          result = model.edit(request.op, request.revision, request.view);
          break;
      }
    }
    self.postMessage({ requestId: request.requestId, result } satisfies DelimitedResponse);
  } catch (error) {
    self.postMessage({
      requestId: request.requestId,
      error: error instanceof DelimitedError ? error.code : 'invalid',
    } satisfies DelimitedResponse);
  }
};
