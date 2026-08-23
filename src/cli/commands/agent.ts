import path from 'node:path';
import { analyzeProject } from '../../core/analyze.js';
import { writeAgentFile, AGENT_FILE } from '../../agent/agent-file.js';
import { colors, dim, icons } from '../../output/theme.js';
import { owlHeader, renderNextStep } from '../../output/guided.js';
import { loadProjectConfig, print, resolveRoot, type GlobalOptions } from '../runtime.js';

export interface AgentOptions extends GlobalOptions {
  force?: boolean;
}

/**
 * `little-owl agent` — write the file AI assistants read before touching this
 * project.
 *
 * `init` already writes it, but most people meet Little Owl after their project
 * exists, and "run init again with --force" is a strange answer to "how do I
 * get the assistant briefing?".
 */
export const agentCommand = async (options: AgentOptions): Promise<number> => {
  const root = resolveRoot(options);
  const config = await loadProjectConfig(root);
  const { result, context } = await analyzeProject({ root, config });

  const outcome = writeAgentFile(
    root,
    { project: result.project, config, layers: context.layers },
    options.force ? { force: true } : {},
  );

  print(owlHeader());
  if (!outcome.written) {
    print(`${colors.yellow(icons.warn)} ${AGENT_FILE} already exists — left untouched.`);
    print('');
    print(dim('Run with --force to replace it.'));
    print('');
    return 0;
  }

  print(`${colors.green(icons.ok)} Wrote ${colors.bold(path.relative(root, outcome.path))}`);
  print('');
  print(dim('Claude Code, Cursor and other assistants read this file automatically.'));
  print(dim('It tells them how this project is organised and what not to change.'));
  print('');
  print(renderNextStep({ command: 'little-owl check', note: 'see what needs attention' }));
  print('');
  return 0;
};
