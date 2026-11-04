import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {findingsFor, scanRepository} from './check-public-repository.mjs';

const privateHost = ['customer-resource', 'vault', 'azure', 'net'].join('.');
const privateGuid = ['12345678', '9abc', '4def', '8123', '123456789abc'].join('-');

function withRepository(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'repository-hygiene-'));
  const git = args => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: 'pipe'}).trim();
  const commit = () => { git(['add', '-A']); git(['commit', '-m', 'Fixture revision']); return git(['rev-parse', 'HEAD']); };
  try {
    git(['init', '--initial-branch=main']);
    git(['config', 'user.name', 'Test Author']);
    git(['config', 'user.email', 'author@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']); // Disposable fixture repository only.
    run({cwd, git, commit, write: (name, contents) => writeFileSync(join(cwd, name), contents)});
  } finally { rmSync(cwd, {recursive: true, force: true}); }
}

test('detects resource hosts, resource names, GUIDs and credential files without returning values', () => {
  const result = findingsFor('.env', `ENDPOINT=https://${privateHost}\nID=${privateGuid}`);
  assert.deepEqual(result.map(row => row.rule), ['private-configuration-file', 'azure-resource-host', 'non-example-guid']);
  assert(!JSON.stringify(result).includes(privateGuid));
  assert(!JSON.stringify(result).includes(privateHost));
  assert.equal(findingsFor('sample.md', 'probonolaw' + 'customerstorage')[0].rule, 'organization-resource-name');
});

test('permits SDK names, platform URLs, placeholders and synthetic fixtures', () => {
  assert.deepEqual(findingsFor('settings.json.example', [
    'Azure.Identity https://storage.azure.com/.default',
    'https://<resource>.vault.azure.net',
    'https://example-ai.services.ai.azure.com',
    'https://example.blob.core.windows.net',
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-2222-2222-222222222222',
  ].join('\n')), []);
});

test('detects an identifier removed from the current tree but retained in history', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'repository-hygiene-'));
  const git = args => execFileSync('git', args, {cwd, stdio: 'pipe'});
  try {
    git(['init', '--initial-branch=main']);
    git(['config', 'user.name', 'Test Author']);
    git(['config', 'user.email', 'author@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']); // Disposable fixture repository only.
    writeFileSync(join(cwd, 'settings.txt'), `https://${privateHost}`);
    git(['add', '.']); git(['commit', '-m', 'Fixture with identifier']);
    writeFileSync(join(cwd, 'settings.txt'), 'https://example.vault.azure.net');
    git(['add', '.']); git(['commit', '-m', 'Remove identifier']);
    assert.equal(scanRepository({cwd}).findings.length, 0);
    assert.equal(scanRepository({cwd, history: true}).findings.length, 1);
    writeFileSync(join(cwd, 'new.txt'), privateGuid);
    assert.equal(scanRepository({cwd}).findings.length, 1);
  } finally {
    rmSync(cwd, {recursive: true, force: true});
  }
});

test('bounded history checks side branches, temporary leaks and resurrected historical blobs', () => {
  withRepository(({cwd, git, commit, write}) => {
    write('settings.txt', privateHost);
    const archived = commit();
    git(['branch', 'archived', archived]);
    write('settings.txt', 'https://example.vault.azure.net');
    const historyFrom = commit();
    assert.equal(scanRepository({cwd, history: true}).findings.length, 1);
    assert.equal(scanRepository({cwd, history: true, historyFrom}).findings.length, 0);

    git(['switch', '-c', 'feature']);
    write('transient.txt', privateGuid); commit();
    git(['rm', 'transient.txt']); commit();
    git(['switch', 'main']);
    assert.equal(scanRepository({cwd}).findings.length, 0);
    assert.equal(scanRepository({cwd, history: true, historyFrom}).findings.length, 1);

    write('settings.txt', privateHost); commit(); // Same blob as the archived revision.
    write('settings.txt', 'https://example.vault.azure.net'); commit();
    const result = scanRepository({cwd, history: true, historyFrom});
    assert.equal(scanRepository({cwd}).findings.length, 0);
    assert.deepEqual(result.findings.map(f => f.rule).sort(), ['azure-resource-host', 'non-example-guid']);
  });
});

test('the cleanup boundary is scanned and must be a valid ancestor', () => {
  withRepository(({cwd, git, commit, write}) => {
    write('settings.txt', privateHost);
    const historyFrom = commit();
    assert.equal(scanRepository({cwd, history: true, historyFrom}).findings.length, 1);
    assert.throws(() => scanRepository({cwd, history: true, historyFrom: 'main'}), /full lowercase commit SHA/);
    assert.throws(() => scanRepository({cwd, historyFrom}), /requires history scanning/);
    git(['switch', '--orphan', 'unrelated']);
    write('other.txt', 'example'); const unrelated = commit();
    git(['switch', 'main']);
    assert.throws(() => scanRepository({cwd, history: true, historyFrom: unrelated}));
  });
});

test('history checks path rules even when a rename reuses a previously scanned blob', () => {
  withRepository(({cwd, git, commit, write}) => {
    write('example.txt', 'example'); const historyFrom = commit();
    mkdirSync(join(cwd, 'k8s'));
    git(['mv', 'example.txt', 'k8s/example.yaml']); commit();
    git(['rm', 'k8s/example.yaml']); commit();
    assert.equal(scanRepository({cwd}).findings.length, 0);
    for (const options of [{history: true}, {history: true, historyFrom}])
      assert.deepEqual(scanRepository({cwd, ...options}).findings.map(f => f.rule), ['private-operations-file']);
  });
});

test('renaming a forbidden configuration file to an allowed name cannot hide its history', () => {
  withRepository(({cwd, git, commit, write}) => {
    write('README.md', 'example'); const historyFrom = commit();
    write('production.appsettings.json', '{}'); commit();
    const originalBlob = git(['rev-parse', 'HEAD:production.appsettings.json']);
    git(['mv', 'production.appsettings.json', 'settings.example.json']); commit();
    assert.equal(git(['rev-parse', 'HEAD:settings.example.json']), originalBlob);
    assert.equal(scanRepository({cwd}).findings.length, 0);
    for (const options of [{history: true}, {history: true, historyFrom}]) {
      assert.deepEqual(scanRepository({cwd, ...options}).findings, [{
        file: 'production.appsettings.json', line: 1,
        rule: 'private-configuration-file', object: originalBlob.slice(0, 12),
      }]);
    }
  });
});

test('public CI and manual history audits ignore the internal migration boundary', () => {
  withRepository(({cwd, commit, write}) => {
    write('settings.txt', privateHost); commit();
    write('settings.txt', 'example'); const baseline = commit();
    const script = fileURLToPath(new URL('./check-public-repository.mjs', import.meta.url));
    for (const [visibility, boundary, flag, expected] of [
      ['internal', baseline, '--ci-history', 0],
      ['private', baseline, '--ci-history', 0],
      ['public', baseline, '--ci-history', 1],
      ['', baseline, '--ci-history', 1],
      ['unknown', baseline, '--ci-history', 1],
      ['internal', '', '--ci-history', 1],
      ['internal', baseline, '--history', 1],
    ]) {
      const result = spawnSync(process.execPath, [script, flag], {cwd, encoding: 'utf8', env: {
        ...process.env, REPOSITORY_VISIBILITY: visibility, PUBLIC_HISTORY_BASELINE: boundary,
      }});
      assert.equal(result.status, expected, `${visibility} ${flag}: ${result.stderr}`);
      assert(!result.stderr.includes(privateHost));
    }
  });
});
