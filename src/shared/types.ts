// Isomorphic core types. No DOM, no I/O, no imports from server or web.

export const STEP_TYPES = ['info', 'single-select', 'multi-select', 'number', 'result'] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** Step types that collect an answer and may be referenced by conditions. */
export const ANSWER_STEP_TYPES = ['single-select', 'multi-select', 'number'] as const;

export const OPERATORS = ['eq', 'neq', 'in', 'nin', 'gt', 'gte', 'lt', 'lte', 'contains'] as const;
export type Operator = (typeof OPERATORS)[number];

export type StepId = string;
export type Scalar = string | number | boolean;
export type AnswerValue = Scalar | Scalar[];
/** Keyed by step ID. */
export type Answers = Record<StepId, AnswerValue>;

export interface ConditionLeaf {
  answer: StepId;
  operator: Operator;
  value: unknown;
}
export type ConditionNode =
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | { not: ConditionNode }
  | ConditionLeaf;

export interface SelectOption {
  value: string;
  label: string;
}

export interface StepContent {
  eyebrow?: string;
  title?: string;
  body?: string;
  helperText?: string;
  primaryActionLabel?: string;
  loadingTitle?: string;
  errorTitle?: string;
  retryLabel?: string;
  [key: string]: unknown;
}

export interface StepInput {
  name?: string;
  options?: SelectOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  [key: string]: unknown;
}

export interface StepValidation {
  required?: boolean;
  minSelections?: number;
  maxSelections?: number;
  messages?: Record<string, string>;
}

export interface Step {
  id: StepId;
  /** Whitelisted at publish time; typed loosely so the renderer can handle stored unknown types. */
  type: StepType | (string & {});
  content?: StepContent;
  input?: StepInput;
  validation?: StepValidation;
  visibleWhen?: ConditionNode;
  resultSource?: string;
  [key: string]: unknown;
}

export interface ResultCta {
  label: string;
  action: string;
}

export interface ResultDefinition {
  id: string;
  title: string;
  summary?: string;
  recommendations?: string[];
  cta?: ResultCta;
  [key: string]: unknown;
}

export interface ResultRule {
  resultId: string;
  when: ConditionNode;
}

export interface EventDefinition {
  name: string;
  trigger?: string;
  properties: string[];
}

export interface EventsConfig {
  baseProperties?: string[];
  allowed: EventDefinition[];
  privacy?: Record<string, unknown>;
}

export interface SessionSettings {
  ttlHours: number;
  [key: string]: unknown;
}

export interface ProgressSettings {
  countVisibleOnly?: boolean;
  excludeTypes?: string[];
}

export interface VariantDefinition {
  weight: number;
  stepSequence: StepId[];
  stepOverrides?: Record<StepId, Record<string, unknown>>;
  resultOverrides?: Record<string, Record<string, unknown>>;
}

export interface ExperimentConfig {
  id: string;
  assignment?: string;
  sticky?: boolean;
  overrideQueryParam?: string;
  variants: Record<string, VariantDefinition>;
}

/** The funnel config as published (informational fields such as status/locale are ignored). */
export interface FunnelConfig {
  schemaVersion: string;
  funnelId: string;
  version: number;
  status?: string;
  locale?: string;
  title?: string;
  description?: string;
  releaseNote?: string;
  session: SessionSettings;
  progress?: ProgressSettings;
  experiment: ExperimentConfig;
  steps: Record<StepId, Step>;
  resultRules: ResultRule[];
  defaultResultId: string;
  results: Record<string, ResultDefinition>;
  events: EventsConfig;
}

/**
 * A config with one variant applied. The renderer only ever sees this shape and
 * never learns that variants exist.
 */
export interface MaterialisedConfig {
  funnelId: string;
  version: number;
  title?: string;
  session: SessionSettings;
  progress: { excludeTypes: string[] };
  stepSequence: StepId[];
  steps: Record<StepId, Step>;
  resultRules: ResultRule[];
  defaultResultId: string;
  results: Record<string, ResultDefinition>;
  events: EventsConfig;
}

export type ValidationResult = { ok: true } | { ok: false; message: string };

export interface Progress {
  current: number;
  total: number;
}

export interface NavigationState {
  currentStepId: StepId | null;
  visibleSteps: StepId[];
  progress: Progress;
  resultId: string | null;
}
