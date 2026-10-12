import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.cwd();
const out = join(root, 'dist');
await mkdir(out, { recursive: true });
for (const name of ['index.html', 'styles.css', 'app.js']) {
  await copyFile(join(root, 'web', name), join(out, name));
}
await copyFile(join(root, 'shared', 'engine.js'), join(out, 'engine.js'));
await copyFile(join(root, 'shared', 'engine.js'), join(root, 'supabase', 'functions', '_shared', 'engine.js'));
// These are public-only keys. NEVER put your secret/service-role key here.
const config = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '',
};
await writeFile(join(out, 'config.js'), `export const config = ${JSON.stringify(config)};\n`);
console.log('Built dist/ with shared engine. Cloud enabled:', !!(config.supabaseUrl && config.supabaseKey));
