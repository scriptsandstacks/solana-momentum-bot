import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { botConfigSchema, type BotConfig } from './schema.js';

export function parseConfig(raw: unknown): BotConfig {
  return botConfigSchema.parse(raw);
}

export function loadConfigFromFile(configPath = 'config.yaml'): BotConfig {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const text = fs.readFileSync(absolutePath, 'utf8');
  const raw = YAML.parse(text) as unknown;
  return parseConfig(raw);
}
