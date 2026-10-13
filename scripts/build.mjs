import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = process.cwd();
const out = join(root, 'dist');
const fingerprint = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
await mkdir(out, { recursive: true });

// Fingerprint the import URLs, not the filenames, so every deployment requests
// matching frontend and math-engine versions even behind the /race24 proxy.
const engine = await readFile(join(root, 'shared', 'engine.js'), 'utf8');
const engineVersion = fingerprint(engine);
await writeFile(join(out, 'engine.js'), engine);
await writeFile(join(root, 'supabase', 'functions', '_shared', 'engine.js'), engine);

const appSource = await readFile(join(root, 'web', 'app.js'), 'utf8');
if (!appSource.includes("from './engine.js'")) throw Error('Expected engine import missing from web/app.js');
const app = appSource.replace("from './engine.js'", `from './engine.js?v=${engineVersion}'`);
const appVersion = fingerprint(app);
await writeFile(join(out, 'app.js'), app);

const styles = await readFile(join(root, 'web', 'styles.css'), 'utf8');
const stylesVersion = fingerprint(styles);
await writeFile(join(out, 'styles.css'), styles);

let html = await readFile(join(root, 'web', 'index.html'), 'utf8');
if (!html.includes('src="./app.js"') || !html.includes('href="./styles.css"')) {
  throw Error('Expected assets missing from web/index.html');
}
html = html
  .replace('src="./app.js"', `src="./app.js?v=${appVersion}"`)
  .replace('href="./styles.css"', `href="./styles.css?v=${stylesVersion}"`);
await writeFile(join(out, 'index.html'), html);

// Public keys only. Never put Supabase secret/service-role credentials here.
const config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '',
};
await writeFile(join(out, 'config.js'), `export const config = ${JSON.stringify(config)};\n`);
console.log(`Built versioned assets (app ${appVersion}, engine ${engineVersion}). Cloud enabled:`, !!(config.supabaseUrl && config.supabaseKey));
