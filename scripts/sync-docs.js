#!/usr/bin/env node

/**
 * Documentation Sync Script
 *
 * 检查 README.md 是否与代码库状态同步
 * 检查内容包括：
 * - CLI 命令（src/cli/commands/）
 * - MCP 工具（src/mcp/tools/）
 * - 环境变量（src/config/schema.ts）
 *
 * 选项：
 * --check-new-only    只检查新增文件，忽略修改/删除
 * --quiet             静默模式，只输出结果
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');

const COLORS = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m',
};

// 解析命令行参数
const args = process.argv.slice(2);
const checkNewOnly = args.includes('--check-new-only');
const quiet = args.includes('--quiet');

function log(color, ...args) {
  if (!quiet) {
    console.log(color, ...args, COLORS.reset);
  }
}

function readMarkdownFile(filePath) {
  try {
    return readFileSync(join(projectRoot, filePath), 'utf-8');
  } catch {
    return null;
  }
}

// 获取 Git 新增文件列表（如果是 new-only 模式）
function getNewFiles() {
  try {
    // 获取暂存区的新增文件
    const stagedFiles = execSync('git diff --cached --name-only --diff-filter=A', {
      cwd: projectRoot,
      encoding: 'utf-8',
    });

    // 获取工作区的新增文件
    const workingFiles = execSync('git ls-files --others --exclude-standard', {
      cwd: projectRoot,
      encoding: 'utf-8',
    });

    return [...stagedFiles.split('\n'), ...workingFiles.split('\n')]
      .filter(f => f && f.endsWith('.ts'));
  } catch {
    return [];
  }
}

// 将连字符文件名转换为下划线命名（skill-list -> skill_list）
function toSnakeCase(name) {
  return name.replace(/-/g, '_');
}

// 提取表格中带反引号的项目
function extractBacktickItems(sectionContent) {
  const items = new Set();
  const lines = sectionContent.split('\n');

  for (const line of lines) {
    const match = line.match(/\|.*\`([^\`]+)\`/);
    if (match) {
      const item = match[1].trim();
      if (item && !item.includes('|') && item.length > 2) {
        items.add(item);
      }
    }
  }

  return items;
}

// 从 README 提取所有提到的命令
function extractReadmeCommands(readme) {
  const commands = new Set();

  // 从 CLI Commands Reference 部分提取
  const cliMatch = readme.match(/## CLI Commands Reference\s+[\s\S]+?\n\n/);
  if (cliMatch) {
    const lines = cliMatch[0].split('\n');
    for (const line of lines) {
      const matches = line.matchAll(/\`([a-z]+)(?:\s|\`)/g);
      for (const match of matches) {
        commands.add(match[1]);
      }
    }
  }

  // 从其他部分也提取（比如 Quick Start）
  const otherMatches = readme.matchAll(/\`skill-mcp ([a-z]+)\`/g);
  for (const match of otherMatches) {
    commands.add(match[1]);
  }

  return commands;
}

// 提取 README 中的 MCP 工具列表
function extractReadmeTools(readme) {
  const match = readme.match(/## MCP Tools\s+[\s\S]+?\n\n/);
  if (!match) return new Set();
  return extractBacktickItems(match[0]);
}

// 扫描 CLI 命令目录
function scanCliCommands() {
  const commandsDir = join(projectRoot, 'src', 'cli', 'commands');
  const commands = new Set();

  try {
    const files = readdirSync(commandsDir);
    for (const file of files) {
      // Only files matching `<name>-cmd.ts` are CLI command entrypoints.
      // Helper modules (e.g. serve-stdio-auth.ts) live in the same directory
      // but are not standalone commands.
      if (file.endsWith('-cmd.ts') && !file.startsWith('_')) {
        const cmdName = file.replace(/-cmd\.ts$/, '').replace(/_/g, '-');
        commands.add(cmdName);
      }
    }
  } catch {
    log(COLORS.red, '❌ 无法读取 CLI 命令目录');
  }

  return commands;
}

// 扫描 MCP 工具目录
function scanMcpTools() {
  const toolsDir = join(projectRoot, 'src', 'mcp', 'tools');
  const tools = new Set();

  try {
    const files = readdirSync(toolsDir);
    for (const file of files) {
      if (file.endsWith('.ts') && !file.startsWith('_') && file !== 'registry.ts') {
        const toolName = file.replace(/\.ts$/, '');
        tools.add(toSnakeCase(toolName));
      }
    }
  } catch {
    log(COLORS.red, '❌ 无法读取 MCP 工具目录');
  }

  return tools;
}

// 提取 config schema 中的环境变量
function extractEnvVarsFromSchema() {
  const schemaPath = join(projectRoot, 'src', 'config', 'schema.ts');
  const schema = readFileSync(schemaPath, 'utf-8');

  const envVars = new Set();
  const envMatch = schema.match(/process\.env\.([A-Z_]+)/g);

  if (envMatch) {
    for (const match of envMatch) {
      const varName = match.replace('process.env.', '');
      envVars.add(varName);
    }
  }

  return envVars;
}

// 提取 README 中的环境变量列表
function extractReadmeEnvVars(readme) {
  const match = readme.match(/### Environment Variables\s+[\s\S]+?\n\n/);
  if (!match) return new Set();
  return extractBacktickItems(match[0]);
}

// 检查新增文件是否影响文档
function checkNewFiles(newFiles) {
  const changes = {
    cli: [],
    mcp: [],
    config: false,
  };

  for (const file of newFiles) {
    // 检查新增的 CLI 命令
    if (file.startsWith('src/cli/commands/') && file.endsWith('-cmd.ts')) {
      const cmdName = file.replace(/^src\/cli\/commands\//, '').replace(/-cmd\.ts$/, '').replace(/_/g, '-');
      changes.cli.push(cmdName);
    }
    // 检查新增的 MCP 工具
    else if (file.startsWith('src/mcp/tools/') && file.endsWith('.ts') && file !== 'src/mcp/tools/registry.ts') {
      const toolName = file.replace(/^src\/mcp\/tools\//, '').replace(/\.ts$/, '').replace(/-/g, '_');
      changes.mcp.push(toolName);
    }
    // 检查配置变更
    else if (file === 'src/config/schema.ts') {
      changes.config = true;
    }
  }

  return changes;
}

function main() {
  if (!checkNewOnly) {
    log(COLORS.blue, '\n📄 检查 README.md 同步状态...\n');
  }

  const readme = readMarkdownFile('README.md');
  if (!readme) {
    log(COLORS.red, '❌ 无法读取 README.md');
    process.exit(1);
  }

  const readmeZh = readMarkdownFile('README.zh.md');

  let hasChanges = false;
  let newCliCommands = [];
  let newMcpTools = [];
  let configChanged = false;

  // 如果是 new-only 模式，先获取新增文件
  if (checkNewOnly) {
    const newFiles = getNewFiles();
    const changes = checkNewFiles(newFiles);

    if (changes.cli.length === 0 && changes.mcp.length === 0 && !changes.config) {
      // 没有影响文档的新增文件，直接通过
      process.exit(0);
    }

    newCliCommands = changes.cli;
    newMcpTools = changes.mcp;
    configChanged = changes.config;
  }

  // 检查 CLI 命令
  log(COLORS.blue, '🔍 检查 CLI 命令...');
  const readmeCommands = extractReadmeCommands(readme);
  const actualCommands = scanCliCommands();

  // 如果是 new-only 模式，只检查新增的命令
  const commandsToCheck = checkNewOnly ? new Set(newCliCommands) : actualCommands;
  const missingCommands = [...commandsToCheck].filter(c => !readmeCommands.has(c));

  if (missingCommands.length > 0) {
    hasChanges = true;
    log(COLORS.yellow, `⚠️  缺少的 CLI 命令: ${missingCommands.join(', ')}`);
  } else {
    log(COLORS.green, '✅ CLI 命令同步');
  }

  // 检查 MCP 工具
  log(COLORS.blue, '🔍 检查 MCP 工具...');
  const readmeTools = extractReadmeTools(readme);
  const actualTools = scanMcpTools();

  // 如果是 new-only 模式，只检查新增的工具
  const toolsToCheck = checkNewOnly ? new Set(newMcpTools) : actualTools;
  const missingTools = [...toolsToCheck].filter(t => !readmeTools.has(t));

  if (missingTools.length > 0) {
    hasChanges = true;
    log(COLORS.yellow, `⚠️  缺少的 MCP 工具: ${missingTools.join(', ')}`);
  } else {
    log(COLORS.green, '✅ MCP 工具同步');
  }

  // 检查环境变量（仅在 full 模式或 config 文件新增/变更时检查）
  if (!checkNewOnly || configChanged) {
    log(COLORS.blue, '🔍 检查环境变量...');
    const readmeEnvVars = extractReadmeEnvVars(readme);
    const actualEnvVars = extractEnvVarsFromSchema();
    const missingEnvVars = [...actualEnvVars].filter(v => !readmeEnvVars.has(v));

    if (missingEnvVars.length > 0) {
      hasChanges = true;
      log(COLORS.yellow, `⚠️  缺少的环境变量: ${missingEnvVars.join(', ')}`);
    } else {
      log(COLORS.green, '✅ 环境变量同步');
    }
  }

  // 检查中文 README 是否存在（仅在 full 模式下检查）
  if (!checkNewOnly) {
    log(COLORS.blue, '🔍 检查中文 README...');
    if (!readmeZh) {
      hasChanges = true;
      log(COLORS.yellow, '⚠️  README.zh.md 不存在');
    } else {
      log(COLORS.green, '✅ README.zh.md 存在');
    }
  }

  if (hasChanges) {
    log(COLORS.yellow, '\n⚠️  README.md 可能需要更新');
    log(COLORS.blue, '💡 提示：运行 `npm run docs:sync` 检查同步状态');
    log(COLORS.blue, '💡 在提交前请确保 README.md 和 README.zh.md 都是最新的\n');
    process.exit(1);
  } else {
    log(COLORS.green, '\n✅ README.md 与代码库同步\n');
    process.exit(0);
  }
}

main();