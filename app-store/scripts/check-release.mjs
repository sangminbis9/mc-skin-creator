import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const config = JSON.parse(read('store.config.json'));
const errors = [];
for (const key of ['name', 'subtitle']) if (!config[key] || [...config[key]].length > 30) errors.push(`${key}: must contain 1–30 characters.`);
for (const key of ['supportUrl', 'privacyPolicyUrl']) {
  try { if (new URL(config[key]).protocol !== 'https:') throw Error(); } catch { errors.push(`${key}: supply a public HTTPS page you operate.`); }
}
if (!config.copyright) errors.push('copyright: supply the actual rights holder.');
if (!/^[A-Z0-9]{10}$/.test(config.appleTeamId)) errors.push('appleTeamId: supply your Apple Developer Team ID (not a secret).');
for (const key of ['privacyAnswersReviewed', 'physicalDeviceTested', 'assetRightsReviewed']) if (config[key] !== true) errors.push(`${key}: complete the release checklist before setting true.`);
const project = read('ios/App/App.xcodeproj/project.pbxproj');
const capacitor = read('capacitor.config.ts');
if (!project.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${config.bundleId};`) || !capacitor.includes(`appId: '${config.bundleId}'`)) errors.push('Bundle IDs must agree in store.config.json, capacitor.config.ts and Xcode.');
if (/server\s*:|allowNavigation\s*:/.test(capacitor)) errors.push('Remove remote-server/navigation overrides from release configuration.');
if (!project.includes('PrivacyInfo.xcprivacy in Resources')) errors.push('Privacy manifest is not bundled by Xcode.');
if (!existsSync(resolve(root, 'dist/index.html'))) errors.push('Run npm run ios:sync before the release check.');
if (errors.length) { console.error('Release preparation incomplete:\n- ' + errors.join('\n- ')); process.exitCode = 1; }
else console.log('Local release checklist passed. This does not verify signing, live URLs, provider policies or Apple approval.');
