import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { guardedBuildEnvironment, guardedProfileDigest, readGuardedProfile } from './guarded-release-profile.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const id = process.argv[2];
const codeOnly = process.argv[3] === '--code-only';
if (!/^crm-\d{8}-prepared(?:-[a-z0-9]+)?$/.test(id || '') || process.argv.length !== (codeOnly ? 4 : 3)) throw new Error('Supply a new crm-YYYYMMDD-prepared release ID and optionally --code-only. This command never activates a release.');
const destination = path.join(root, 'outputs', id);
await fs.mkdir(destination);
const source = path.join(destination, 'source');
const profile = await readGuardedProfile();
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const command = (file, args, options = {}) => {
  const result = spawnSync(file, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error('Release preparation command failed; no online process was changed.');
  return result.stdout;
};
const tracked = command('git', ['ls-files', '-z']).split('\0').filter(Boolean);
const removed = new Set(command('git', ['ls-files', '--deleted', '-z']).split('\0').filter(Boolean));
const additions = ['docs/guarded-online-activation.md', 'scripts/attendance-rollout-guard.mjs', 'scripts/attendance-rollout-guard.test.mjs',
  'release/guarded-profile.json', 'scripts/guarded-release-profile.mjs', 'scripts/guarded-release-profile.test.mjs',
  'scripts/prepare-guarded-release.mjs', 'backend/src/config/guardedReleaseProfile.test.ts',
  'scripts/attendance-undertime-status.test.mjs', 'scripts/lead-work-queue-priority.test.mjs',
  'scripts/call-bridge-activation.test.mjs', 'docs/online-activation-20261022.md',
  'backend/src/services/callBridgeHeartbeat.integration.test.ts', 'scripts/call-dashboard-freshness.test.mjs',
  'scripts/call-bridge-sampling.test.mjs', 'scripts/test-call-bridge-sampling.ps1',
  'scripts/call-bridge-download.test.mjs', 'backend/src/services/callBridgeDownload.integration.test.ts',
  'scripts/lead-page-loading.test.mjs', 'shared/leadCallingPolicy.ts',
  'src/lib/callingWorkflow.ts', 'src/lib/useCallingQueue.ts', 'backend/src/services/employeeCallingQueue.ts',
  'backend/src/services/employeeCallingQueue.integration.test.ts', 'docs/calling-queue-alignment.md',
  'scripts/calling-queue-policy.test.mjs', 'scripts/calling-queue-reproduction.test.mjs', 'scripts/calling-queue-browser.mjs', 'scripts/calling-workflow.test.mjs',
  'scripts/calling-settings.test.mjs', 'docs/call-timing-verification.md',
  'shared/leadAssignmentPolicy.ts', 'backend/src/services/leadAssignment.ts',
  'backend/src/services/leadAssignment.integration.test.ts', 'src/lib/requestErrorToast.ts',
  'scripts/lead-reassignment.test.mjs', 'scripts/lead-reassignment-browser.mjs', 'docs/lead-reassignment-verification.md',
  'shared/leadPhonePolicy.ts', 'backend/src/config/leadWorkspaceRuntime.ts', 'backend/src/config/leadWorkspaceRuntime.test.ts',
  'backend/src/controllers/employeeLeadArchiveController.ts', 'backend/src/services/leadPhoneCanonical.ts',
  'backend/src/services/leadPhoneDispatch.ts', 'backend/src/services/leadPhoneWriteGuard.ts',
  'backend/src/services/leadPhoneSnapshotCache.ts', 'backend/src/services/leadPhoneSnapshotCache.test.ts',
  'backend/src/services/leadPhonePolicy.test.ts', 'backend/src/services/leadPhoneWorkspace.integration.test.ts',
  'src/components/EmployeeLeadSelection.tsx', 'src/components/EmployeeLeadArchiveDialog.tsx',
  'scripts/current-call-display-browser.mjs', 'scripts/lead-phone-cleanup.mjs',
  'src/lib/attendanceUndo.ts', 'scripts/attendance-undo-ui.test.mjs', 'backend/src/services/attendanceUndo.integration.test.ts',
  'src/lib/leadWorkspaceCache.ts', 'scripts/lead-live-workspace.test.mjs', 'scripts/lead-live-workspace-browser.mjs', 'scripts/attendance-undo-browser.mjs'];
const safe = file => !file.split(/[\\/]/).some(part => ['.git', 'node_modules', 'outputs', 'uploads', 'logs', 'dist'].includes(part) || part.startsWith('.env')) &&
  !/\.(?:pem|key|pfx|p12|bson|archive|gcm|log|zip|rar|7z|tgz)$/i.test(file);
const names = [...new Set([...tracked, ...additions])].filter(file => safe(file) && !removed.has(file)).sort();
const files = [];
for (const name of names) {
  const original = path.join(root, name);
  if ((await fs.lstat(original)).isSymbolicLink()) throw new Error('Source export must contain regular files, not links.');
  const bytes = await fs.readFile(original);
  const target = path.join(source, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
}
const environment = guardedBuildEnvironment(process.env, profile);
environment.CRM_VITE_CACHE_DIR = path.join(destination, 'vite-cache');
command(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-b'], { env: environment, stdio: 'inherit' });
const inline = `import {build} from 'vite';await build({envDir:false,publicDir:${JSON.stringify(path.join(source, 'public'))},build:{outDir:${JSON.stringify(path.join(destination, 'dist'))},emptyOutDir:false}});`;
command(process.execPath, ['--input-type=module', '-e', inline], { env: environment, stdio: 'inherit' });
command(process.execPath, [path.join(root, 'backend/scripts/prepare-build.mjs')], { cwd: path.join(root, 'backend'), stdio: 'inherit' });
command(process.execPath, [path.join(root, 'backend/node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: path.join(root, 'backend'), stdio: 'inherit' });
command(process.execPath, [path.join(root, 'backend/scripts/resolve-built-imports.mjs')], { cwd: path.join(root, 'backend'), stdio: 'inherit' });
await fs.cp(path.join(root, 'backend/dist'), path.join(destination, 'backend/dist'), { recursive: true });
for (const item of files) if (digest(await fs.readFile(path.join(root, item.path))) !== item.sha256) throw new Error('Source changed during preparation. Prepare a fresh release before publishing.');
const ts = createRequire(path.join(root, 'package.json'))('typescript');
const app = ts.createSourceFile('App.tsx', await fs.readFile(path.join(source, 'src/App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const routes = [];
function visit(node) {
  if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(app) === 'Route') {
    const attribute = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(app) === 'path');
    if (attribute?.initializer && ts.isStringLiteral(attribute.initializer)) routes.push(attribute.initializer.text);
  }
  ts.forEachChild(node, visit);
}
visit(app);
const commit = command('git', ['rev-parse', 'HEAD']).trim();
const release = { release: id, sourceCommit: commit, preparedAt: new Date().toISOString(), rollout: 'prepared-not-activated', profileSha256: guardedProfileDigest(profile) };
await fs.writeFile(path.join(destination, 'dist/release.json'), JSON.stringify(release));
const buildFiles = [];
const bridgeFiles = ['AssistlyCallBridge.ps1', 'install-windows.ps1', 'install-windows.cmd', 'update-windows.ps1',
  'update-windows.cmd', 'uninstall-windows.ps1', 'README.md'];
const bridgeDirectory = path.join(destination, 'callbridge/dist');
await fs.mkdir(bridgeDirectory, { recursive: true });
const psString = value => `'${value.replaceAll("'", "''")}'`;
command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -LiteralPath @(${bridgeFiles.map(name => psString(path.join(source, 'callbridge', name))).join(',')}) -DestinationPath ${psString(path.join(bridgeDirectory, 'assistly-call-bridge.zip'))} -CompressionLevel Optimal`]);
async function scan(directory, prefix) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name), relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await scan(name, relative);
    else if (entry.isFile()) { const bytes = await fs.readFile(name); buildFiles.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) }); }
    else throw new Error('Build output contains an unexpected link.');
  }
}
await scan(path.join(destination, 'dist'), 'dist'); await scan(path.join(destination, 'backend/dist'), 'backend/dist');
await scan(bridgeDirectory, 'callbridge/dist');
await fs.writeFile(path.join(destination, 'release-manifest.json'), JSON.stringify({ ...release, profile, files, buildFiles, routes,
  excludesPrivateConfigurationAndUploads: true, localDatabaseCopied: false, requiresFreshLiveCopy: !codeOnly,
  retainsCurrentAuthoritativeDatabase: codeOnly, requiresConfirmedQuietWindow: true }, null, 2));
command('tar', ['-czf', path.join(destination, 'source.tar.gz'), '-C', source, '.']);
command('tar', ['-czf', path.join(destination, 'build.tar.gz'), '-C', destination, 'dist', 'backend/dist', 'callbridge/dist']);
console.log(JSON.stringify({ prepared: true, activated: false, release: id, sourceFiles: files.length, buildFiles: buildFiles.length,
  routes: routes.length, profileSha256: release.profileSha256, codeOnly, privateConfigurationOrLocalDataCopied: false }));
