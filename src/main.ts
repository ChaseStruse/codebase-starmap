import { App, loadToken } from './app';
import { openCache } from './github/cache';
import { GitHubClient } from './github/client';
import './style.css';

function webglAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

async function main() {
  if (!webglAvailable()) {
    document.getElementById('nogl')!.hidden = false;
    document.getElementById('landing')!.hidden = true;
    return;
  }
  const cache = await openCache();
  const client = new GitHubClient({ cache, token: loadToken() });
  const app = new App(client, cache);
  await app.route();
}

void main();
