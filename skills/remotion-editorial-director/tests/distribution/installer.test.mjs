import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  installSkill,
  rollbackSkill,
  uninstallSkill,
} from '../../scripts/install.mjs';

const makeSource = async (root, version, marker = version) => {
  const source = path.join(root, `source-${version}`);
  await mkdir(path.join(source, 'agents'), {recursive: true});
  await mkdir(path.join(source, 'scripts'), {recursive: true});
  await writeFile(path.join(source, 'SKILL.md'), `---\nname: remotion-editorial-director\ndescription: Test.\n---\n${marker}\n`);
  await writeFile(path.join(source, 'agents/openai.yaml'), 'interface:\n  display_name: Test\n');
  await writeFile(path.join(source, 'scripts/runtime.mjs'), `export default ${JSON.stringify(marker)};\n`);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({name: 'test-skill', version}));
  await writeFile(path.join(source, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, name: 'test-skill', packages: {'': {name: 'test-skill', version}}, version}));
  return source;
};

const noDependencies = async () => {};

test('installer atomically installs and treats matching content as an idempotent no-op', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'editorial-install-'));
  const source = await makeSource(home, '1.0.0');
  const target = path.join(home, '.codex/skills/remotion-editorial-director');
  const installed = await installSkill({installDependencies: noDependencies, source, target});
  const repeated = await installSkill({installDependencies: noDependencies, source, target});

  assert.equal(installed.status, 'ok');
  assert.equal(installed.action, 'installed');
  assert.equal(repeated.action, 'noop');
  assert.equal(repeated.installedVersion, '1.0.0');
  assert.equal(JSON.parse(await readFile(path.join(target, '.install-manifest.json'))).version, '1.0.0');
});

test('installer preserves divergence only with force and rollback restores it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'editorial-divergence-'));
  const sourceV1 = await makeSource(home, '1.0.0');
  const sourceV2 = await makeSource(home, '2.0.0');
  const target = path.join(home, '.codex/skills/remotion-editorial-director');
  await installSkill({installDependencies: noDependencies, source: sourceV1, target});
  await writeFile(path.join(target, 'SKILL.md'), 'locally edited\n');

  await assert.rejects(
    installSkill({installDependencies: noDependencies, source: sourceV2, target}),
    (error) => error.code === 'INSTALLED_FILES_DIVERGED' && error.exitCode === 4,
  );
  const upgraded = await installSkill({
    forceDiverged: true,
    installDependencies: noDependencies,
    source: sourceV2,
    target,
  });
  assert.equal(upgraded.installedVersion, '2.0.0');
  assert.deepEqual(upgraded.divergedFiles, ['SKILL.md']);
  const rolledBack = await rollbackSkill({target});
  assert.equal(rolledBack.installedVersion, '1.0.0');
  assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), 'locally edited\n');
});

test('failed promotion restores the previously installed version', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'editorial-promotion-'));
  const sourceV1 = await makeSource(home, '1.0.0');
  const sourceV2 = await makeSource(home, '2.0.0');
  const target = path.join(home, '.codex/skills/remotion-editorial-director');
  await installSkill({installDependencies: noDependencies, source: sourceV1, target});
  await assert.rejects(
    installSkill({
      failpoint: 'after-backup',
      installDependencies: noDependencies,
      source: sourceV2,
      target,
    }),
    (error) => error.code === 'INSTALL_PROMOTION_FAILED',
  );
  assert.equal(JSON.parse(await readFile(path.join(target, 'package.json'))).version, '1.0.0');
});

test('uninstall refuses divergence and otherwise retains a rollback copy', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'editorial-uninstall-'));
  const source = await makeSource(home, '1.0.0');
  const target = path.join(home, '.codex/skills/remotion-editorial-director');
  await installSkill({installDependencies: noDependencies, source, target});
  await writeFile(path.join(target, 'scripts/runtime.mjs'), 'changed\n');
  await assert.rejects(
    uninstallSkill({target}),
    (error) => error.code === 'INSTALLED_FILES_DIVERGED',
  );
  const result = await uninstallSkill({forceDiverged: true, target});
  assert.equal(result.action, 'uninstalled');
  await assert.rejects(stat(target), (error) => error.code === 'ENOENT');
  assert.equal(await readFile(path.join(result.rollbackPath, 'scripts/runtime.mjs'), 'utf8'), 'changed\n');
});
