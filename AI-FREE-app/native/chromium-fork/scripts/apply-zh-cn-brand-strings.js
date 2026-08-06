const fs = require('fs');
const path = require('path');

const forkRoot = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(forkRoot, 'version-lock.json'), 'utf8'));
const sourceRoot = path.resolve(process.argv[2] || lock.chromium.sourceRoot);

const resourceFiles = [
  'chrome/app/resources/chromium_strings_zh-CN.xtb',
  'chrome/app/resources/generated_resources_zh-CN.xtb',
  'components/policy/resources/policy_templates_zh-CN.xtb',
  'components/strings/components_chromium_strings_zh-CN.xtb',
  'components/strings/components_strings_zh-CN.xtb',
  'components/strings/privacy_sandbox_strings_zh-CN.xtb',
];

function isAttributionOrOtherPlatform(line) {
  return line.includes('BEGIN_LINK_CHROMIUM') ||
    line.includes('Chromium 操作系统') ||
    line.includes('ChromiumOS');
}

let changedFiles = 0;
let replacements = 0;
for (const relativePath of resourceFiles) {
  const filePath = path.join(sourceRoot, ...relativePath.split('/'));
  const original = fs.readFileSync(filePath, 'utf8');
  const branded = original.split(/(?<=\n)/).map((line) => {
    if (isAttributionOrOtherPlatform(line)) return line;
    const matches = line.match(/Chromium/g);
    if (!matches) return line;
    replacements += matches.length;
    return line.replaceAll('Chromium', 'AI-FREE');
  }).join('');
  if (branded !== original) {
    fs.writeFileSync(filePath, branded);
    changedFiles += 1;
  }
}

console.log(`Applied ${replacements} AI-FREE replacements across ${changedFiles} zh-CN resource files.`);
