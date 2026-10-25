import type { ZcodeApi } from '../../shared/protocol';

declare global {
  interface Window {
    api: ZcodeApi;
  }
}

export {};
