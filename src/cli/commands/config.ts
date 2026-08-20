import path from 'node:path';
import { loadConfig } from '../../config/load.js';
import { allRules } from '../../rules/index.js';
import { printJson } from '../../output/json.js';
import { colors, dim, icons } from '../../output/theme.js';
import { heading, padEnd } from '../../output/ui.js';
import { print, resolveRoot, type GlobalOptions } from '../runtime.js';
import type { Severity } from '../../core/types.js';

export interface ConfigOptions extends GlobalOptions {
  json?: boolean;
  rules?: boolean;
}

const SEVERITY_PAINT: Record<Severity, (text: string) => string> = {
  error: colors.red,
  warning: colors.yellow,
  info: colors.blue,
  off: dim,
};

/** `little-owl config` — what settings are actually in effect. */
export async function configCommand(options: ConfigOptions): Promise<number> {
  const root = resolveRoot(options);
  const config = await loadConfig(root);

  if (options.json) {
    printJson(config);
    return 0;
  }

  if (options.rules) {
    print(heading('RULES'));
    print('');
    let category = '';
    for (const rule of allRules) {
      const group = rule.id.split('/')[0]!;
      if (group !== category) {
        category = group;
        print('');
        print(colors.bold(group));
        print('');
      }
      const severity = config.rules[rule.id] ?? 'off';
      print(`  ${padEnd(rule.id, 38)} ${SEVERITY_PAINT[severity](padEnd(severity, 8))} ${dim(rule.description)}`);
    }
    print('');
    print(dim('Change any of these in .little-owl/config.ts under `rules`.'));
    return 0;
  }

  print(heading('CONFIGURATION'));
  print('');
  print(
    `${dim('Source')}      ${config.sourcePath ? path.relative(root, config.sourcePath) : `${colors.yellow('defaults')} ${dim('(run `little-owl init`)')}`}`,
  );
  print(`${dim('Strictness')}  ${config.strictness}`);
  print(`${dim('Include')}     ${config.include.length > 0 ? config.include.join(', ') : 'everything'}`);
  print(`${dim('Ignore')}      ${config.ignore.length} patterns`);
  print('');

  print(colors.bold('Architecture'));
  const layers = Object.entries(config.architecture.layers);
  if (layers.length === 0) {
    print(dim('  not configured — layers are inferred from the directory structure'));
  } else {
    for (const [layer, directories] of layers) {
      print(`  ${padEnd(layer, 16)} ${dim(directories.join(', '))}`);
    }
  }
  print(`  ${padEnd('policy', 16)} ${dim(config.architecture.layerPolicy)}`);
  print('');

  print(colors.bold('Thresholds'));
  for (const [key, value] of Object.entries(config.thresholds)) {
    print(`  ${padEnd(key, 22)} ${String(value)}`);
  }
  print('');

  print(colors.bold('CI'));
  print(`  ${padEnd('failOn', 22)} ${config.ci.failOn}`);
  print(`  ${padEnd('maxOverallDrop', 22)} ${config.ci.maxOverallDrop}`);
  print(`  ${padEnd('newFindingsOnly', 22)} ${String(config.ci.newFindingsOnly)}`);
  print('');

  const active = allRules.filter((rule) => (config.rules[rule.id] ?? 'off') !== 'off').length;
  print(dim(`${active} of ${allRules.length} rules active. ${icons.arrow} little-owl config --rules`));
  return 0;
}
