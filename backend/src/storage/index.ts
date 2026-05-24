import { config } from '../config.js';
import { LighthouseStorageProvider } from './lighthouse.js';
import { LocalStorageProvider } from './local.js';
import { MockStorageProvider } from './mock.js';
import type { StorageProvider } from './provider.js';

export function makeStorageProvider(publicBaseUrl: string): StorageProvider {
  switch (config.STORAGE_PROVIDER) {
    case 'lighthouse':
      return new LighthouseStorageProvider(publicBaseUrl, config.LIGHTHOUSE_API_KEY, config.IPFS_GATEWAY);
    case 'local':
      return new LocalStorageProvider(config.LOCAL_STORAGE_DIR);
    case 'mock':
      return new MockStorageProvider(publicBaseUrl);
  }
}

export type { StorageProvider } from './provider.js';
