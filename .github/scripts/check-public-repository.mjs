import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

// Report locations and rule names only. Never echo a potential secret or identifier.
const guid = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
const azureHost = /\b([a-z0-9][a-z0-9-]*)\.(?:(?:blob|queue|table|file|dfs)\.core\.windows\.net|azurecr\.io|servicebus\.windows\.net|documents\.azure\.com|search\.windows\.net|cognitiveservices\.azure\.com|services\.ai\.azure\.com|openai\.azure\.com|vault\.azure\.net|azurewebsites\.net|sharepoint\.com)\b/gi;
const exampleResource = /^(?:example[a-z0-9-]*|test|test-resource|prod-resource|gpt-resource|claude-resource|mistral-resource|contoso|account|storage|contentaccount|checkpointaccount|SEARCH|YOUR-SEARCH|YOUR-FOUNDRY)$/i;
const resourceName = /\b(?:probonolaw[a-z0-9-]+|probono-law-(?:aks|data|storage)[a-z0-9-]*|aimie\d[a-z0-9-]*|aimie-search-[a-z0-9-]+)\b/gi;

export function findingsFor(file, contents) {
  const findings = [];
  const report = (line, rule) => findings.push({file, line, rule});
  if (/(?:^|\/)(?:\.env(?:\..+)?|[^/]*\.(?:pem|key|pfx|p12|publishsettings|tfstate)|[^/]*\.appsettings\.json)$/.test(file)
      && !file.endsWith('.example')) report(1, 'private-configuration-file');
  if (/^(?:k8s\/|docs\/(?:grafana|evaluations)\/|\.github\/workflows\/(?:deploy-|stop-ingestion))/.test(file))
    report(1, 'private-operations-file');
  for (const [index, line] of contents.split('\n').entries()) {
    for (const match of line.matchAll(guid)) {
      // Nil root-account sentinel and deliberately repeated digits in test fixtures.
      if (!/^([0-9a-f])\1{31}$/i.test(match[0].replaceAll('-', '')))
        report(index + 1, 'non-example-guid');
    }
    for (const match of line.matchAll(azureHost))
      if (!exampleResource.test(match[1])) report(index + 1, 'azure-resource-host');
    if ([...line.matchAll(resourceName)].length) report(index + 1, 'organization-resource-name');
    if (/https?:\/\/[^\s"'<>]*\.internal\.(?!example\.(?:invalid|com)\b)[a-z0-9.-]+/i.test(line))
      report(index + 1, 'internal-service-host');
  }
  return findings;
}

export function scanRepository({history = false, historyFrom, cwd = process.cwd()} = {}) {
  const git = args => execFileSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024});
  if (historyFrom && !history) throw new Error('A history boundary requires history scanning');
  const findings = [];
  let scanned = 0;
  if (history) {
    let commits;
    if (historyFrom) {
      if (!/^[0-9a-f]{40}$/.test(historyFrom)) throw new Error('History boundary must be a full lowercase commit SHA');
      // Fail closed if the boundary is unavailable or unrelated to this checkout.
      git(['merge-base', '--is-ancestor', historyFrom, 'HEAD']);
      commits = [historyFrom, ...git(['rev-list', '--all', `--ancestry-path=${historyFrom}`, `^${historyFrom}`])
        .trim().split('\n').filter(Boolean)];
    } else {
      commits = git(['rev-list', '--all']).trim().split('\n').filter(Boolean);
    }
    const seen = new Set(), contents = new Map();
    for (const commit of commits) {
      // Inspect trees, not only newly introduced objects: an old private blob can
      // be resurrected or renamed after cleanup and then removed before PR review.
      for (const entry of git(['ls-tree', '-rz', '--full-tree', commit]).split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        const [mode, type, oid] = entry.slice(0, tab).split(' '), file = entry.slice(tab + 1);
        const revision = `${mode}:${oid}:${file}`;
        if (seen.has(revision)) continue;
        seen.add(revision);
        scanned++;
        if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
          findings.push({file, line: 1, rule: 'review-non-regular-file', object: oid.slice(0, 12)});
          continue;
        }
        if (!contents.has(oid)) contents.set(oid, git(['cat-file', 'blob', oid]));
        findings.push(...findingsFor(file, contents.get(oid))
          .map(finding => ({...finding, object: oid.slice(0, 12)})));
      }
    }
  } else {
    // Include new, non-ignored files so a local pre-commit check sees them too.
    const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    for (const file of new Set(files)) {
      const fullPath = `${cwd}/${file}`;
      if (!fs.existsSync(fullPath)) continue;
      if (!fs.lstatSync(fullPath).isFile()) {
        findings.push({file, line: 1, rule: 'review-non-regular-file'});
        continue;
      }
      scanned++;
      findings.push(...findingsFor(file, fs.readFileSync(fullPath, 'utf8')));
    }
  }
  return {scanned, findings};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--history', '--ci-history'].includes(arg)))
    throw new Error('Usage: check-public-repository.mjs [--history|--ci-history]');
  const history = args.length > 0;
  // Only the existing nonpublic repository may exclude its archived ancestors.
  // Public or unknown visibility always scans every reachable commit, regardless
  // of any inherited repository variable. --history is always a complete audit.
  const historyFrom = args.includes('--ci-history') && ['internal', 'private'].includes(process.env.REPOSITORY_VISIBILITY)
    ? process.env.PUBLIC_HISTORY_BASELINE || undefined : undefined;
  const {scanned, findings} = scanRepository({history, historyFrom});
  for (const finding of findings.slice(0, 100))
    console.error(`${finding.file}:${finding.line}: ${finding.rule}${finding.object ? ` (blob ${finding.object})` : ''}`);
  console.log(`Scanned ${scanned} ${history ? 'historical file revisions' : 'files'}${historyFrom ? ` from cleanup commit ${historyFrom}` : ''}; ${findings.length} findings.`);
  process.exitCode = findings.length ? 1 : 0;
}
