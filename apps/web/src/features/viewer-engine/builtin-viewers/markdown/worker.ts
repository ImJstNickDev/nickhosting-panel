import { parseMarkdown } from './parser';

self.onmessage = async (event: MessageEvent<{ id: number; source: string }>) => {
  const { id, source } = event.data;
  try {
    self.postMessage({ id, model: await parseMarkdown(source) });
  } catch (error) {
    self.postMessage({
      id,
      error:
        error instanceof Error && error.message === 'markdown_limit'
          ? 'markdown_limit'
          : 'markdown_invalid',
    });
  }
};
