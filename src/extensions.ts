import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { CheckpointMetadata, GeneratedInsightRecord } from "./types.js";

export interface RegisteredExtension {
  id: string;
  enabled: boolean;
  command: string;
  description?: string;
}

export interface VerificationProfile {
  id: string;
  command: string;
  autoRun?: boolean;
  description?: string;
  includePaths: string[];
  excludePaths: string[];
  minChangedFiles?: number;
  cooldownMinutes?: number;
}

export interface OrchestrationHookRule {
  id: string;
  enabled: boolean;
  mode: "blocking" | "background";
  host?: string;
  event?: string;
  includePaths: string[];
  excludePaths: string[];
  actions: OrchestrationAction[];
}

export interface OrchestrationCheckpointRule {
  id: string;
  enabled: boolean;
  mode: "blocking" | "background";
  includePaths: string[];
  excludePaths: string[];
  actions: OrchestrationAction[];
}

export interface OrchestrationAction {
  type: "runProfile" | "runVerification" | "runExtension" | "runCommand";
  profile?: string;
  extensionId?: string;
  command?: string;
}

export interface OrchestrationConfig {
  afterHook: {
    rules: OrchestrationHookRule[];
  };
  beforeCheckpoint: {
    rules: OrchestrationCheckpointRule[];
  };
  afterCheckpoint: {
    rules: OrchestrationCheckpointRule[];
    extensions: RegisteredExtension[];
    verifications: {
      enabled: boolean;
      profiles: VerificationProfile[];
    };
  };
}

export interface ExtensionCheckpointPayload {
  version: 1;
  repositoryRoot: string;
  checkpoint: CheckpointMetadata;
}

export interface ExtensionInsightOutput {
  type: string;
  title: string;
  body: string;
  files?: string[];
}

export interface ExtensionRunnerOutput {
  insights?: ExtensionInsightOutput[];
}

export interface HookOrchestrationEvent {
  hookName: string;
  host: "copilotVs" | "copilotCli" | "codex";
  event: "PreToolUse" | "PermissionRequest" | "PostToolUse" | "UserPromptSubmit";
  files: string[];
  checkpointId?: string | null;
  timestamp: string;
}

export interface EnsureOrchestrationTemplateResult {
  filePath: string;
  created: boolean;
  migratedFromLegacy: boolean;
}

interface LegacyExtensionsConfig {
  extensions: RegisteredExtension[];
  verifications: {
    enabled: boolean;
    profiles: VerificationProfile[];
  };
}

const ORCHESTRATION_FILE_NAME = "orchestration.yaml";
const LEGACY_EXTENSIONS_FILE_NAME = "extensions.yaml";
const GENERATED_INSIGHTS_FILE_NAME = "generated-insights.jsonl";
const PENDING_EXTENSION_EVENTS_FILE_NAME = "pending-extension-events.jsonl";
const PENDING_HOOK_ORCHESTRATION_EVENTS_FILE_NAME = "pending-hook-orchestration-events.jsonl";
const VERIFICATION_LOGS_DIR_NAME = "verification-logs";

export function orchestrationConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", ORCHESTRATION_FILE_NAME);
}

export function legacyExtensionsConfigPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", LEGACY_EXTENSIONS_FILE_NAME);
}

export function generatedInsightsPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", GENERATED_INSIGHTS_FILE_NAME);
}

export function pendingExtensionEventsPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", PENDING_EXTENSION_EVENTS_FILE_NAME);
}

export function pendingHookOrchestrationEventsPath(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", PENDING_HOOK_ORCHESTRATION_EVENTS_FILE_NAME);
}

export function verificationLogsRoot(repositoryRoot: string): string {
  return path.join(repositoryRoot, ".anvil", VERIFICATION_LOGS_DIR_NAME);
}

function parseBoolean(value: string): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unquote(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function parseInlineList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => unquote(item))
    .filter(Boolean);
}

function renderExtensionBlock(extension: RegisteredExtension): string {
  const lines = [
    `  ${extension.id}:`,
    `    enabled: ${extension.enabled ? "true" : "false"}`,
    `    command: ${extension.command}`
  ];
  if (extension.description) {
    lines.push(`    description: "${extension.description.replace(/"/g, '\\"')}"`);
  }
  return lines.join("\n");
}

function renderVerificationBlock(profile: VerificationProfile): string {
  const lines = [
    `  ${profile.id}:`,
    `    command: ${profile.command}`
  ];
  if (profile.description) {
    lines.push(`    description: "${profile.description.replace(/"/g, '\\"')}"`);
  }
  if (profile.includePaths.length > 0) {
    lines.push("    includePaths:");
    for (const value of profile.includePaths) {
      lines.push(`      - ${value}`);
    }
  }
  if (profile.excludePaths.length > 0) {
    lines.push("    excludePaths:");
    for (const value of profile.excludePaths) {
      lines.push(`      - ${value}`);
    }
  }
  if (typeof profile.minChangedFiles === "number") {
    lines.push(`    minChangedFiles: ${profile.minChangedFiles}`);
  }
  if (typeof profile.cooldownMinutes === "number") {
    lines.push(`    cooldownMinutes: ${profile.cooldownMinutes}`);
  }
  return lines.join("\n");
}

function renderOrchestrationTemplate(config?: LegacyExtensionsConfig): string {
  const profiles = config?.verifications.profiles ?? [
    {
      id: "build",
      command: "npm run build",
      autoRun: false,
      includePaths: [],
      excludePaths: []
    },
    {
      id: "test",
      command: "npm test -- --watch=false",
      autoRun: false,
      includePaths: [],
      excludePaths: []
    },
    {
      id: "lint",
      command: "npm run lint",
      autoRun: false,
      includePaths: [],
      excludePaths: []
    }
  ];

  const verificationBlocks = profiles.map(renderVerificationBlock).join("\n");

  return `# Repo-local Anvil orchestration
# profiles register reusable commands for runProfile actions.
profiles:
${verificationBlocks}

# lifecycle controls when Anvil runs trusted automation.
lifecycle:
  aiHooks:
    copilotVs:
      rules: {}
    copilotCli:
      rules: {}
    codex:
      rules: {}

  beforeCheckpoint:
    rules: {}

  afterCheckpoint:
    rules: {}
`;
}

function emptyLegacyConfig(): LegacyExtensionsConfig {
  return {
    extensions: [],
    verifications: {
      enabled: false,
      profiles: []
    }
  };
}

function emptyOrchestrationConfig(): OrchestrationConfig {
  return {
    afterHook: {
      rules: []
    },
    beforeCheckpoint: {
      rules: []
    },
    afterCheckpoint: {
      rules: [],
      extensions: [],
      verifications: {
        enabled: false,
        profiles: []
      }
    }
  };
}

function parseLegacyExtensionsContent(content: string): LegacyExtensionsConfig {
  const config = emptyLegacyConfig();
  let inExtensions = false;
  let inVerifications = false;
  let inVerificationProfiles = false;
  let currentExtension: RegisteredExtension | null = null;
  let currentVerification: VerificationProfile | null = null;
  let activeVerificationArray: "includePaths" | "excludePaths" | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (!line.startsWith(" ")) {
      inExtensions = trimmed === "extensions:";
      inVerifications = trimmed === "verifications:";
      inVerificationProfiles = false;
      currentExtension = null;
      currentVerification = null;
      activeVerificationArray = null;
      continue;
    }

    if (inExtensions) {
      if (line.startsWith("  ") && !line.startsWith("    ")) {
        const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
        if (!match) {
          currentExtension = null;
          continue;
        }
        currentExtension = {
          id: match[1],
          enabled: false,
          command: ""
        };
        config.extensions.push(currentExtension);
        continue;
      }

      if (!currentExtension) {
        continue;
      }

      const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.+)?$/);
      if (!pair) {
        continue;
      }

      const [, key, rawValue = ""] = pair;
      const value = unquote(rawValue);
      switch (key) {
        case "enabled": {
          const parsed = parseBoolean(value);
          currentExtension.enabled = parsed ?? currentExtension.enabled;
          break;
        }
        case "command":
          currentExtension.command = value;
          break;
        case "description":
          currentExtension.description = value;
          break;
      }
      continue;
    }

    if (!inVerifications) {
      continue;
    }

    if (line.startsWith("  ") && !line.startsWith("    ")) {
      currentVerification = null;
      activeVerificationArray = null;

      if (trimmed === "profiles:") {
        inVerificationProfiles = true;
        continue;
      }

      inVerificationProfiles = false;
      const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.+)?$/);
      if (!pair) {
        continue;
      }

      const [, key, rawValue = ""] = pair;
      const value = unquote(rawValue);
      if (key === "enabled") {
        const parsed = parseBoolean(value);
        config.verifications.enabled = parsed ?? config.verifications.enabled;
      }
      continue;
    }

    if (!inVerificationProfiles) {
      continue;
    }

    if (line.startsWith("    ") && !line.startsWith("      ")) {
      const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
      if (!match) {
        currentVerification = null;
        activeVerificationArray = null;
        continue;
      }

      currentVerification = {
        id: match[1],
        command: "",
        autoRun: false,
        includePaths: [],
        excludePaths: []
      };
      config.verifications.profiles.push(currentVerification);
      activeVerificationArray = null;
      continue;
    }

    if (!currentVerification) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (!activeVerificationArray) {
        continue;
      }
      const listValue = unquote(trimmed.slice(2));
      if (listValue) {
        currentVerification[activeVerificationArray].push(listValue);
      }
      continue;
    }

    activeVerificationArray = null;
    const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      continue;
    }

    const [, key, rawValue = ""] = pair;
    const value = unquote(rawValue);
    switch (key) {
      case "command":
        currentVerification.command = value;
        break;
      case "description":
        currentVerification.description = value;
        break;
      case "autoRun": {
        const parsed = parseBoolean(value);
        currentVerification.autoRun = parsed ?? currentVerification.autoRun;
        break;
      }
      case "minChangedFiles": {
        const parsed = parseNumber(value);
        if (parsed !== null && parsed >= 0) {
          currentVerification.minChangedFiles = parsed;
        }
        break;
      }
      case "cooldownMinutes": {
        const parsed = parseNumber(value);
        if (parsed !== null && parsed >= 0) {
          currentVerification.cooldownMinutes = parsed;
        }
        break;
      }
      case "includePaths":
      case "excludePaths": {
        activeVerificationArray = key as "includePaths" | "excludePaths";
        if (value) {
          currentVerification[activeVerificationArray].push(...parseInlineList(value));
        }
        break;
      }
    }
  }

  config.extensions = config.extensions.filter((extension) => extension.command.trim().length > 0);
  config.verifications.profiles = config.verifications.profiles.filter((profile) => profile.command.trim().length > 0);
  return config;
}

function applyActionField(action: OrchestrationAction, key: string, value: string): void {
  switch (key) {
    case "type":
      if (
        value === "runProfile" ||
        value === "runVerification" ||
        value === "runExtension" ||
        value === "runCommand"
      ) {
        action.type = value;
      }
      break;
    case "profile":
      action.profile = value || undefined;
      break;
    case "extensionId":
      action.extensionId = value || undefined;
      break;
    case "command":
      action.command = value || undefined;
      break;
  }
}

function parseLifecycleContent(content: string): OrchestrationConfig {
  const config = emptyOrchestrationConfig();
  let topLevelSection: "extensions" | "profiles" | "lifecycle" | null = null;
  let lifecycleSection: "aiHooks" | "beforeCheckpoint" | "afterCheckpoint" | null = null;
  let currentAgent: string | null = null;
  let currentExtension: RegisteredExtension | null = null;
  let currentProfile: VerificationProfile | null = null;
  let currentHookRule: OrchestrationHookRule | null = null;
  let currentCheckpointRule: OrchestrationCheckpointRule | null = null;
  let currentAction: OrchestrationAction | null = null;
  let activeProfileArray: "includePaths" | "excludePaths" | null = null;
  let activeRuleArray: "includePaths" | "excludePaths" | null = null;
  let inActions = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (!line.startsWith(" ")) {
      topLevelSection =
        trimmed === "extensions:" ? "extensions" : trimmed === "profiles:" ? "profiles" : trimmed === "lifecycle:" ? "lifecycle" : null;
      lifecycleSection = null;
      currentAgent = null;
      currentExtension = null;
      currentProfile = null;
      currentHookRule = null;
      currentCheckpointRule = null;
      currentAction = null;
      activeProfileArray = null;
      activeRuleArray = null;
      inActions = false;
      continue;
    }

    if (topLevelSection === "extensions") {
      if (line.startsWith("  ") && !line.startsWith("    ")) {
        const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
        if (!match) {
          currentExtension = null;
          continue;
        }

        currentExtension = {
          id: match[1],
          enabled: false,
          command: ""
        };
        config.afterCheckpoint.extensions.push(currentExtension);
        continue;
      }

      if (!currentExtension) {
        continue;
      }

      const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.+)?$/);
      if (!pair) {
        continue;
      }

      const [, key, rawValue = ""] = pair;
      const value = unquote(rawValue);
      switch (key) {
        case "enabled": {
          const parsed = parseBoolean(value);
          currentExtension.enabled = parsed ?? currentExtension.enabled;
          break;
        }
        case "command":
          currentExtension.command = value;
          break;
        case "description":
          currentExtension.description = value;
          break;
      }
      continue;
    }

    if (topLevelSection === "profiles") {
      if (line.startsWith("  ") && !line.startsWith("    ")) {
        const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
        if (!match) {
          currentProfile = null;
          activeProfileArray = null;
          continue;
        }

        currentProfile = {
          id: match[1],
          command: "",
          autoRun: false,
          includePaths: [],
          excludePaths: []
        };
        config.afterCheckpoint.verifications.profiles.push(currentProfile);
        config.afterCheckpoint.verifications.enabled = true;
        activeProfileArray = null;
        continue;
      }

      if (!currentProfile) {
        continue;
      }

      if (trimmed.startsWith("- ")) {
        if (!activeProfileArray) {
          continue;
        }
        const listValue = unquote(trimmed.slice(2));
        if (listValue) {
          currentProfile[activeProfileArray].push(listValue);
        }
        continue;
      }

      activeProfileArray = null;
      const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!pair) {
        continue;
      }

      const [, key, rawValue = ""] = pair;
      const value = unquote(rawValue);
      switch (key) {
        case "command":
          currentProfile.command = value;
          break;
        case "description":
          currentProfile.description = value;
          break;
        case "autoRun": {
          const parsed = parseBoolean(value);
          currentProfile.autoRun = parsed ?? currentProfile.autoRun;
          break;
        }
        case "minChangedFiles": {
          const parsed = parseNumber(value);
          if (parsed !== null && parsed >= 0) {
            currentProfile.minChangedFiles = parsed;
          }
          break;
        }
        case "cooldownMinutes": {
          const parsed = parseNumber(value);
          if (parsed !== null && parsed >= 0) {
            currentProfile.cooldownMinutes = parsed;
          }
          break;
        }
        case "includePaths":
        case "excludePaths":
          activeProfileArray = key as "includePaths" | "excludePaths";
          if (value) {
            currentProfile[activeProfileArray].push(...parseInlineList(value));
          }
          break;
      }
      continue;
    }

    if (topLevelSection !== "lifecycle") {
      continue;
    }

    if (line.startsWith("  ") && !line.startsWith("    ")) {
      lifecycleSection =
        trimmed === "aiHooks:" ? "aiHooks" : trimmed === "beforeCheckpoint:" ? "beforeCheckpoint" : trimmed === "afterCheckpoint:" ? "afterCheckpoint" : null;
      currentAgent = null;
      currentHookRule = null;
      currentCheckpointRule = null;
      currentAction = null;
      activeRuleArray = null;
      inActions = false;
      continue;
    }

    if (lifecycleSection === "aiHooks") {
      if (line.startsWith("    ") && !line.startsWith("      ")) {
        const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
        currentAgent = match ? (match[1] === "copilot" ? "copilotVs" : match[1]) : null;
        currentHookRule = null;
        currentAction = null;
        activeRuleArray = null;
        inActions = false;
        continue;
      }

      if (!currentAgent) {
        continue;
      }

      if (line.startsWith("      ") && !line.startsWith("        ")) {
        continue;
      }

      if (trimmed === "{}") {
        continue;
      }

      if (line.startsWith("        ") && !line.startsWith("          ")) {
        const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
        if (!match) {
          currentHookRule = null;
          activeRuleArray = null;
          continue;
        }

        currentHookRule = {
          id: match[1],
          enabled: false,
          mode: "background",
          host: currentAgent,
          includePaths: [],
          excludePaths: [],
          actions: []
        };
        config.afterHook.rules.push(currentHookRule);
        continue;
      }

      if (!currentHookRule) {
        continue;
      }

      if (trimmed.startsWith("- ")) {
        if (inActions) {
          currentAction = { type: "runCommand" };
          currentHookRule.actions.push(currentAction);
          const inlinePair = trimmed.slice(2).trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
          if (inlinePair) {
            const [, key, rawValue = ""] = inlinePair;
            applyActionField(currentAction, key, unquote(rawValue));
          }
          continue;
        }

        if (!activeRuleArray) {
          continue;
        }
        const listValue = unquote(trimmed.slice(2));
        if (listValue) {
          currentHookRule[activeRuleArray].push(listValue);
        }
        continue;
      }

      if (line.startsWith("              ")) {
        if (!inActions || !currentAction) {
          continue;
        }
        const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!pair) {
          continue;
        }
        const [, key, rawValue = ""] = pair;
        applyActionField(currentAction, key, unquote(rawValue));
        continue;
      }

      activeRuleArray = null;
      const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!pair) {
        continue;
      }
      const [, key, rawValue = ""] = pair;
      const value = unquote(rawValue);
      switch (key) {
        case "enabled": {
          const parsed = parseBoolean(value);
          currentHookRule.enabled = parsed ?? currentHookRule.enabled;
          break;
        }
        case "mode":
          currentHookRule.mode = value === "blocking" ? "blocking" : "background";
          break;
        case "event":
          currentHookRule.event = value || undefined;
          break;
        case "actions":
          inActions = true;
          currentAction = null;
          break;
        case "includePaths":
        case "excludePaths":
          inActions = false;
          currentAction = null;
          activeRuleArray = key as "includePaths" | "excludePaths";
          if (value) {
            currentHookRule[activeRuleArray].push(...parseInlineList(value));
          }
          break;
      }
      continue;
    }

    if (lifecycleSection !== "beforeCheckpoint" && lifecycleSection !== "afterCheckpoint") {
      continue;
    }

    if (line.startsWith("    ") && !line.startsWith("      ")) {
      continue;
    }

    if (trimmed === "{}") {
      continue;
    }

    if (line.startsWith("      ") && !line.startsWith("        ")) {
      const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
      if (!match) {
        currentCheckpointRule = null;
        activeRuleArray = null;
        continue;
      }

      currentCheckpointRule = {
        id: match[1],
        enabled: false,
        mode: "background",
        includePaths: [],
        excludePaths: [],
        actions: []
      };
      (lifecycleSection === "beforeCheckpoint" ? config.beforeCheckpoint.rules : config.afterCheckpoint.rules).push(
        currentCheckpointRule
      );
      continue;
    }

    if (!currentCheckpointRule) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (inActions) {
        currentAction = { type: "runCommand" };
        currentCheckpointRule.actions.push(currentAction);
        const inlinePair = trimmed.slice(2).trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (inlinePair) {
          const [, key, rawValue = ""] = inlinePair;
          applyActionField(currentAction, key, unquote(rawValue));
        }
        continue;
      }

      if (!activeRuleArray) {
        continue;
      }
      const listValue = unquote(trimmed.slice(2));
      if (listValue) {
        currentCheckpointRule[activeRuleArray].push(listValue);
      }
      continue;
    }

    if (line.startsWith("            ")) {
      if (!inActions || !currentAction) {
        continue;
      }
      const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!pair) {
        continue;
      }
      const [, key, rawValue = ""] = pair;
      applyActionField(currentAction, key, unquote(rawValue));
      continue;
    }

    activeRuleArray = null;
    const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      continue;
    }
    const [, key, rawValue = ""] = pair;
    const value = unquote(rawValue);
    switch (key) {
      case "enabled": {
        const parsed = parseBoolean(value);
        currentCheckpointRule.enabled = parsed ?? currentCheckpointRule.enabled;
        break;
      }
      case "mode":
        currentCheckpointRule.mode = value === "blocking" ? "blocking" : "background";
        break;
      case "actions":
        inActions = true;
        currentAction = null;
        break;
      case "includePaths":
      case "excludePaths":
        inActions = false;
        currentAction = null;
        activeRuleArray = key as "includePaths" | "excludePaths";
        if (value) {
          currentCheckpointRule[activeRuleArray].push(...parseInlineList(value));
        }
        break;
    }
  }

  config.afterCheckpoint.extensions = config.afterCheckpoint.extensions.filter((extension) => extension.command.trim().length > 0);
  config.afterCheckpoint.verifications.profiles = config.afterCheckpoint.verifications.profiles.filter(
    (profile) => profile.command.trim().length > 0
  );
  return config;
}

function parseOrchestrationContent(content: string): OrchestrationConfig {
  const config = emptyOrchestrationConfig();
  let topLevelSection: "afterHook" | "afterCheckpoint" | null = null;
  let afterHookSubsection: "rules" | null = null;
  let afterCheckpointSubsection: "rules" | "extensions" | "verifications" | null = null;
  let inVerificationProfiles = false;
  let currentExtension: RegisteredExtension | null = null;
  let currentVerification: VerificationProfile | null = null;
  let currentHookRule: OrchestrationHookRule | null = null;
  let currentCheckpointRule: OrchestrationCheckpointRule | null = null;
  let activeVerificationArray: "includePaths" | "excludePaths" | null = null;
  let activeHookArray: "includePaths" | "excludePaths" | null = null;
  let activeCheckpointArray: "includePaths" | "excludePaths" | null = null;
  let inHookActions = false;
  let inCheckpointActions = false;
  let currentHookAction: OrchestrationAction | null = null;
  let currentCheckpointAction: OrchestrationAction | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (!line.startsWith(" ")) {
      topLevelSection = trimmed === "afterHook:" ? "afterHook" : trimmed === "afterCheckpoint:" ? "afterCheckpoint" : null;
      afterHookSubsection = null;
      afterCheckpointSubsection = null;
      inVerificationProfiles = false;
      currentExtension = null;
      currentVerification = null;
      currentHookRule = null;
      currentCheckpointRule = null;
      currentHookAction = null;
      currentCheckpointAction = null;
      activeVerificationArray = null;
      activeHookArray = null;
      activeCheckpointArray = null;
      inHookActions = false;
      inCheckpointActions = false;
      continue;
    }

    if (topLevelSection === "afterHook") {
      if (line.startsWith("  ") && !line.startsWith("    ")) {
        afterHookSubsection = trimmed === "rules:" ? "rules" : null;
        currentHookRule = null;
        activeHookArray = null;
        continue;
      }

      if (afterHookSubsection !== "rules") {
        continue;
      }

      if (trimmed === "{}") {
        continue;
      }

      if (line.startsWith("    ") && !line.startsWith("      ")) {
        const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
        if (!match) {
          currentHookRule = null;
          activeHookArray = null;
          continue;
        }
        currentHookRule = {
          id: match[1],
          enabled: false,
          mode: "background",
          includePaths: [],
          excludePaths: [],
          actions: []
        };
        config.afterHook.rules.push(currentHookRule);
        continue;
      }

      if (!currentHookRule) {
        continue;
      }

      if (trimmed.startsWith("- ")) {
        if (inHookActions) {
          currentHookAction = {
            type: "runCommand"
          };
          currentHookRule.actions.push(currentHookAction);

          const inlinePair = trimmed.slice(2).trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
          if (inlinePair) {
            const [, key, rawValue = ""] = inlinePair;
            const value = unquote(rawValue);
            switch (key) {
              case "type":
                if (
                  value === "runProfile" ||
                  value === "runVerification" ||
                  value === "runExtension" ||
                  value === "runCommand"
                ) {
                  currentHookAction.type = value;
                }
                break;
              case "profile":
                currentHookAction.profile = value || undefined;
                break;
              case "extensionId":
                currentHookAction.extensionId = value || undefined;
                break;
              case "command":
                currentHookAction.command = value || undefined;
                break;
            }
          }
          continue;
        }

        if (!activeHookArray) {
          continue;
        }
        const listValue = unquote(trimmed.slice(2));
        if (listValue) {
          currentHookRule[activeHookArray].push(listValue);
        }
        continue;
      }

      activeHookArray = null;
      if (line.startsWith("          ")) {
        if (!inHookActions || !currentHookAction) {
          continue;
        }

        const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!pair) {
          continue;
        }

        const [, key, rawValue = ""] = pair;
        const value = unquote(rawValue);
        switch (key) {
          case "type":
            if (
              value === "runProfile" ||
              value === "runVerification" ||
              value === "runExtension" ||
              value === "runCommand"
            ) {
              currentHookAction.type = value;
            }
            break;
          case "profile":
            currentHookAction.profile = value || undefined;
            break;
          case "extensionId":
            currentHookAction.extensionId = value || undefined;
            break;
          case "command":
            currentHookAction.command = value || undefined;
            break;
        }
        continue;
      }

      const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!pair) {
        continue;
      }

      const [, key, rawValue = ""] = pair;
      const value = unquote(rawValue);
      switch (key) {
        case "enabled": {
          const parsed = parseBoolean(value);
          currentHookRule.enabled = parsed ?? currentHookRule.enabled;
          break;
        }
        case "mode":
          currentHookRule.mode = value === "blocking" ? "blocking" : "background";
          break;
        case "host":
          currentHookRule.host = value || undefined;
          break;
        case "event":
          currentHookRule.event = value || undefined;
          break;
        case "actions":
          inHookActions = true;
          currentHookAction = null;
          break;
        case "includePaths":
        case "excludePaths": {
          inHookActions = false;
          currentHookAction = null;
          activeHookArray = key as "includePaths" | "excludePaths";
          if (value) {
            currentHookRule[activeHookArray].push(...parseInlineList(value));
          }
          break;
        }
      }
      continue;
    }

    if (topLevelSection !== "afterCheckpoint") {
      continue;
    }

    if (line.startsWith("  ") && !line.startsWith("    ")) {
      afterCheckpointSubsection =
        trimmed === "rules:" ? "rules" : trimmed === "extensions:" ? "extensions" : trimmed === "verifications:" ? "verifications" : null;
      inVerificationProfiles = false;
      currentCheckpointRule = null;
      currentExtension = null;
      currentVerification = null;
      activeCheckpointArray = null;
      activeVerificationArray = null;
      inCheckpointActions = false;
      currentCheckpointAction = null;
      continue;
    }

    if (afterCheckpointSubsection === "rules") {
      if (trimmed === "{}") {
        continue;
      }

      if (line.startsWith("    ") && !line.startsWith("      ")) {
        const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
        if (!match) {
          currentCheckpointRule = null;
          activeCheckpointArray = null;
          continue;
        }

        currentCheckpointRule = {
          id: match[1],
          enabled: false,
          mode: "background",
          includePaths: [],
          excludePaths: [],
          actions: []
        };
        config.afterCheckpoint.rules.push(currentCheckpointRule);
        continue;
      }

      if (!currentCheckpointRule) {
        continue;
      }

      if (trimmed.startsWith("- ")) {
        if (inCheckpointActions) {
          currentCheckpointAction = {
            type: "runCommand"
          };
          currentCheckpointRule.actions.push(currentCheckpointAction);

          const inlinePair = trimmed.slice(2).trim().match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
          if (inlinePair) {
            const [, key, rawValue = ""] = inlinePair;
            const value = unquote(rawValue);
            switch (key) {
              case "type":
                if (
                  value === "runProfile" ||
                  value === "runVerification" ||
                  value === "runExtension" ||
                  value === "runCommand"
                ) {
                  currentCheckpointAction.type = value;
                }
                break;
              case "profile":
                currentCheckpointAction.profile = value || undefined;
                break;
              case "extensionId":
                currentCheckpointAction.extensionId = value || undefined;
                break;
              case "command":
                currentCheckpointAction.command = value || undefined;
                break;
            }
          }
          continue;
        }

        if (!activeCheckpointArray) {
          continue;
        }

        const listValue = unquote(trimmed.slice(2));
        if (listValue) {
          currentCheckpointRule[activeCheckpointArray].push(listValue);
        }
        continue;
      }

      activeCheckpointArray = null;
      if (line.startsWith("          ")) {
        if (!inCheckpointActions || !currentCheckpointAction) {
          continue;
        }

        const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (!pair) {
          continue;
        }

        const [, key, rawValue = ""] = pair;
        const value = unquote(rawValue);
        switch (key) {
          case "type":
            if (
              value === "runProfile" ||
              value === "runVerification" ||
              value === "runExtension" ||
              value === "runCommand"
            ) {
              currentCheckpointAction.type = value;
            }
            break;
          case "profile":
            currentCheckpointAction.profile = value || undefined;
            break;
          case "extensionId":
            currentCheckpointAction.extensionId = value || undefined;
            break;
          case "command":
            currentCheckpointAction.command = value || undefined;
            break;
        }
        continue;
      }

      const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!pair) {
        continue;
      }

      const [, key, rawValue = ""] = pair;
      const value = unquote(rawValue);
      switch (key) {
        case "enabled": {
          const parsed = parseBoolean(value);
          currentCheckpointRule.enabled = parsed ?? currentCheckpointRule.enabled;
          break;
        }
        case "mode":
          currentCheckpointRule.mode = value === "blocking" ? "blocking" : "background";
          break;
        case "actions":
          inCheckpointActions = true;
          currentCheckpointAction = null;
          break;
        case "includePaths":
        case "excludePaths": {
          inCheckpointActions = false;
          currentCheckpointAction = null;
          activeCheckpointArray = key as "includePaths" | "excludePaths";
          if (value) {
            currentCheckpointRule[activeCheckpointArray].push(...parseInlineList(value));
          }
          break;
        }
      }
      continue;
    }

    if (afterCheckpointSubsection === "extensions") {
      if (line.startsWith("    ") && !line.startsWith("      ")) {
        const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
        if (!match) {
          currentExtension = null;
          continue;
        }
        currentExtension = {
          id: match[1],
          enabled: false,
          command: ""
        };
        config.afterCheckpoint.extensions.push(currentExtension);
        continue;
      }

      if (!currentExtension) {
        continue;
      }

      const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.+)?$/);
      if (!pair) {
        continue;
      }
      const [, key, rawValue = ""] = pair;
      const value = unquote(rawValue);
      switch (key) {
        case "enabled": {
          const parsed = parseBoolean(value);
          currentExtension.enabled = parsed ?? currentExtension.enabled;
          break;
        }
        case "command":
          currentExtension.command = value;
          break;
        case "description":
          currentExtension.description = value;
          break;
      }
      continue;
    }

    if (afterCheckpointSubsection !== "verifications") {
      continue;
    }

    if (line.startsWith("    ") && !line.startsWith("      ")) {
      currentVerification = null;
      activeVerificationArray = null;

      if (trimmed === "profiles:") {
        inVerificationProfiles = true;
        continue;
      }

      inVerificationProfiles = false;
      const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.+)?$/);
      if (!pair) {
        continue;
      }

      const [, key, rawValue = ""] = pair;
      const value = unquote(rawValue);
      if (key === "enabled") {
        const parsed = parseBoolean(value);
        config.afterCheckpoint.verifications.enabled = parsed ?? config.afterCheckpoint.verifications.enabled;
      }
      continue;
    }

    if (!inVerificationProfiles) {
      continue;
    }

    if (line.startsWith("      ") && !line.startsWith("        ")) {
      const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*$/);
      if (!match) {
        currentVerification = null;
        activeVerificationArray = null;
        continue;
      }

      currentVerification = {
        id: match[1],
        command: "",
        autoRun: false,
        includePaths: [],
        excludePaths: []
      };
      config.afterCheckpoint.verifications.profiles.push(currentVerification);
      activeVerificationArray = null;
      continue;
    }

    if (!currentVerification) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      if (!activeVerificationArray) {
        continue;
      }
      const listValue = unquote(trimmed.slice(2));
      if (listValue) {
        currentVerification[activeVerificationArray].push(listValue);
      }
      continue;
    }

    activeVerificationArray = null;
    const pair = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      continue;
    }

    const [, key, rawValue = ""] = pair;
    const value = unquote(rawValue);
    switch (key) {
      case "command":
        currentVerification.command = value;
        break;
      case "description":
        currentVerification.description = value;
        break;
      case "autoRun": {
        const parsed = parseBoolean(value);
        currentVerification.autoRun = parsed ?? currentVerification.autoRun;
        break;
      }
      case "minChangedFiles": {
        const parsed = parseNumber(value);
        if (parsed !== null && parsed >= 0) {
          currentVerification.minChangedFiles = parsed;
        }
        break;
      }
      case "cooldownMinutes": {
        const parsed = parseNumber(value);
        if (parsed !== null && parsed >= 0) {
          currentVerification.cooldownMinutes = parsed;
        }
        break;
      }
      case "includePaths":
      case "excludePaths": {
        activeVerificationArray = key as "includePaths" | "excludePaths";
        if (value) {
          currentVerification[activeVerificationArray].push(...parseInlineList(value));
        }
        break;
      }
    }
  }

  config.afterHook.rules = config.afterHook.rules
    .map((rule) => ({
      ...rule,
      actions: rule.actions.filter(
        (action) =>
          action.type === "runCommand"
            ? Boolean(action.command)
            : action.type === "runExtension"
              ? Boolean(action.extensionId)
              : Boolean(action.profile)
      )
    }))
    .filter(
      (rule) =>
        rule.enabled ||
        rule.host ||
        rule.event ||
        rule.includePaths.length > 0 ||
        rule.excludePaths.length > 0 ||
        rule.actions.length > 0
    );
  config.afterCheckpoint.rules = config.afterCheckpoint.rules
    .map((rule) => ({
      ...rule,
      actions: rule.actions.filter(
        (action) =>
          action.type === "runCommand"
            ? Boolean(action.command)
            : action.type === "runExtension"
              ? Boolean(action.extensionId)
              : Boolean(action.profile)
      )
    }))
    .filter(
      (rule) =>
        rule.enabled ||
        rule.includePaths.length > 0 ||
        rule.excludePaths.length > 0 ||
        rule.actions.length > 0
    );
  config.afterCheckpoint.extensions = config.afterCheckpoint.extensions.filter((extension) => extension.command.trim().length > 0);
  config.afterCheckpoint.verifications.profiles = config.afterCheckpoint.verifications.profiles.filter((profile) => profile.command.trim().length > 0);
  return config;
}

export async function ensureOrchestrationTemplate(
  repositoryRoot: string
): Promise<EnsureOrchestrationTemplateResult> {
  const filePath = orchestrationConfigPath(repositoryRoot);
  if (existsSync(filePath)) {
    return { filePath, created: false, migratedFromLegacy: false };
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const legacyPath = legacyExtensionsConfigPath(repositoryRoot);
  if (existsSync(legacyPath)) {
    const legacyContent = await readFile(legacyPath, "utf8");
    const legacyConfig = parseLegacyExtensionsContent(legacyContent);
    await writeFile(filePath, renderOrchestrationTemplate(legacyConfig), "utf8");
    return { filePath, created: true, migratedFromLegacy: true };
  }

  await writeFile(filePath, renderOrchestrationTemplate(), "utf8");
  return { filePath, created: true, migratedFromLegacy: false };
}

export async function loadOrchestrationConfig(repositoryRoot: string): Promise<OrchestrationConfig> {
  const filePath = orchestrationConfigPath(repositoryRoot);
  if (existsSync(filePath)) {
    const content = await readFile(filePath, "utf8");
    if (/^lifecycle:\s*$/m.test(content) || /^profiles:\s*$/m.test(content) || /^extensions:\s*$/m.test(content)) {
      return parseLifecycleContent(content);
    }
    return parseOrchestrationContent(content);
  }

  const legacyPath = legacyExtensionsConfigPath(repositoryRoot);
  if (existsSync(legacyPath)) {
    const content = await readFile(legacyPath, "utf8");
    const legacy = parseLegacyExtensionsContent(content);
    return {
      afterHook: {
        rules: []
      },
      beforeCheckpoint: {
        rules: []
      },
      afterCheckpoint: {
        rules: [],
        extensions: legacy.extensions,
        verifications: legacy.verifications
      }
    };
  }

  return emptyOrchestrationConfig();
}

export async function appendPendingExtensionEvent(
  repositoryRoot: string,
  checkpointId: string
): Promise<void> {
  const filePath = pendingExtensionEventsPath(repositoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify({
    checkpointId,
    queuedAt: new Date().toISOString()
  });
  const prefix = existsSync(filePath) ? "\n" : "";
  await writeFile(
    filePath,
    existsSync(filePath) ? `${(await readFile(filePath, "utf8")).trimEnd()}${prefix}${line}\n` : `${line}\n`,
    "utf8"
  );
}

export async function appendPendingHookOrchestrationEvent(
  repositoryRoot: string,
  event: HookOrchestrationEvent
): Promise<void> {
  const filePath = pendingHookOrchestrationEventsPath(repositoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify(event);
  const prefix = existsSync(filePath) ? "\n" : "";
  await writeFile(
    filePath,
    existsSync(filePath) ? `${(await readFile(filePath, "utf8")).trimEnd()}${prefix}${line}\n` : `${line}\n`,
    "utf8"
  );
}

export async function consumePendingExtensionEvents(repositoryRoot: string): Promise<string[]> {
  const filePath = pendingExtensionEventsPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return [];
  }

  const content = await readFile(filePath, "utf8");
  await writeFile(filePath, "", "utf8");

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line) as { checkpointId?: string };
        return parsed.checkpointId ?? null;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));
}

export async function consumePendingHookOrchestrationEvents(
  repositoryRoot: string
): Promise<HookOrchestrationEvent[]> {
  const filePath = pendingHookOrchestrationEventsPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return [];
  }

  const content = await readFile(filePath, "utf8");
  await writeFile(filePath, "", "utf8");

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as HookOrchestrationEvent;
      } catch {
        return null;
      }
    })
    .filter((value): value is HookOrchestrationEvent => Boolean(value));
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const current = pattern[index];
    const next = pattern[index + 1];
    if (current === "*") {
      if (next === "*") {
        const afterNext = pattern[index + 2];
        if (afterNext === "/") {
          regex += "(?:.*/)?";
          index += 2;
        } else {
          regex += ".*";
          index += 1;
        }
      } else {
        regex += "[^/]*";
      }
      continue;
    }
    if (current === "?") {
      regex += "[^/]";
      continue;
    }
    regex += escapeRegex(current);
  }
  regex += "$";
  return new RegExp(regex);
}

function normalizeRulePath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function matchesRulePath(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizeRulePath(filePath);
  const normalizedPattern = normalizeRulePath(pattern);
  if (!normalizedPattern) {
    return false;
  }

  const directoryPattern = normalizedPattern.endsWith("/");
  const patternBody = directoryPattern ? normalizedPattern.slice(0, -1) : normalizedPattern;
  if (!patternBody) {
    return false;
  }

  if (directoryPattern) {
    return normalizedPath === patternBody || normalizedPath.startsWith(`${patternBody}/`);
  }

  if (patternBody.includes("/")) {
    return globToRegex(patternBody).test(normalizedPath);
  }

  const basename = path.posix.basename(normalizedPath);
  return globToRegex(patternBody).test(basename);
}

function ruleMatchesFiles(includePaths: string[], excludePaths: string[], files: string[]): boolean {
  const normalizedFiles = files.map((file) => normalizeRulePath(file));

  if (includePaths.length > 0) {
    if (normalizedFiles.length === 0) {
      return false;
    }

    const anyIncluded = normalizedFiles.some((file) => includePaths.some((pattern) => matchesRulePath(file, pattern)));
    if (!anyIncluded) {
      return false;
    }
  }

  if (excludePaths.length > 0 && normalizedFiles.length > 0) {
    const anyExcluded = normalizedFiles.some((file) => excludePaths.some((pattern) => matchesRulePath(file, pattern)));
    if (anyExcluded) {
      return false;
    }
  }

  return true;
}

export function matchesAfterHookRule(
  rule: OrchestrationHookRule,
  event: HookOrchestrationEvent
): boolean {
  if (!rule.enabled) {
    return false;
  }

  if (rule.host && rule.host !== event.host) {
    return false;
  }

  if (rule.event && rule.event !== event.event) {
    return false;
  }

  if (!ruleMatchesFiles(rule.includePaths, rule.excludePaths, event.files)) {
    return false;
  }

  return rule.actions.length > 0;
}

export function matchesAfterCheckpointRule(
  rule: OrchestrationCheckpointRule,
  files: string[]
): boolean {
  if (!rule.enabled) {
    return false;
  }

  if (!ruleMatchesFiles(rule.includePaths, rule.excludePaths, files)) {
    return false;
  }

  return rule.actions.length > 0;
}

export async function appendGeneratedInsights(
  repositoryRoot: string,
  insights: GeneratedInsightRecord[]
): Promise<void> {
  if (insights.length === 0) {
    return;
  }

  const filePath = generatedInsightsPath(repositoryRoot);
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = existsSync(filePath) ? await readFile(filePath, "utf8") : "";
  const lines = insights.map((item) => JSON.stringify(item)).join("\n");
  const prefix = existing.trim().length > 0 ? "\n" : "";
  await writeFile(filePath, `${existing.trimEnd()}${prefix}${lines}\n`, "utf8");
}

export async function readGeneratedInsights(
  repositoryRoot: string,
  checkpointId?: string
): Promise<GeneratedInsightRecord[]> {
  const filePath = generatedInsightsPath(repositoryRoot);
  if (!existsSync(filePath)) {
    return [];
  }

  const content = await readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GeneratedInsightRecord)
    .filter((item) => !checkpointId || item.checkpointId === checkpointId);
}

function safeVerificationFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export async function writeVerificationLog(
  repositoryRoot: string,
  checkpointId: string,
  profileId: string,
  content: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(verificationLogsRoot(repositoryRoot), checkpointId);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${safeVerificationFileSegment(profileId)}-${timestamp}.log`);
  await writeFile(filePath, content, "utf8");
  return filePath;
}
