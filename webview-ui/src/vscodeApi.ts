import { isBrowserRuntime } from './runtime';
import { vscode as browserVscode } from './browserApi.js';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export const vscode: { postMessage(msg: unknown): void } = isBrowserRuntime
  ? browserVscode
  : (acquireVsCodeApi() as { postMessage(msg: unknown): void });
