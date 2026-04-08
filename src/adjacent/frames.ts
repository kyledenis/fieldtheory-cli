import type { Frame } from './types.js';

export const DEFAULT_FRAMES: Frame[] = [
  // ── Building group ──────────────────────────────────────────────────────

  {
    id: 'novelty-feasibility',
    name: 'Novelty × Feasibility',
    group: 'building',
    generationPromptAddition:
      'For each candidate, assess how novel it is relative to the current state of the art, and how feasible it is to build with the team and codebase at hand. Favor ideas that surprise without requiring heroics.',
    axisA: {
      label: 'Novelty',
      rubricSentence: '0 = table stakes (everyone already does this), 100 = breakthrough (no one has done this).',
    },
    axisB: {
      label: 'Feasibility',
      rubricSentence: '0 = moonshot (requires unsolved research or years of work), 100 = quick win (can ship in days).',
    },
    quadrantLabels: {
      highHigh: 'Quick wins',
      highLow: 'Moonshots',
      lowHigh: 'Table stakes',
      lowLow: 'Breakthroughs',
    },
  },

  {
    id: 'leverage-specificity',
    name: 'Leverage × Specificity',
    group: 'building',
    generationPromptAddition:
      'For each candidate, consider how much leverage it creates (does fixing or building this unlock many other things?) and how specific or targeted it is. Prefer ideas that solve a real, named problem over speculative platform plays.',
    axisA: {
      label: 'Leverage',
      rubricSentence: '0 = random idea (isolated, no knock-on effects), 100 = foundational fix (unlocks many other improvements).',
    },
    axisB: {
      label: 'Specificity',
      rubricSentence: '0 = speculative platform (solving a problem we don\'t have yet), 100 = targeted polish (precise fix for a known pain).',
    },
    quadrantLabels: {
      highHigh: 'Foundational fix',
      highLow: 'Speculative platform',
      lowHigh: 'Targeted polish',
      lowLow: 'Random idea',
    },
  },

  {
    id: 'impact-effort',
    name: 'Impact × Effort',
    group: 'building',
    generationPromptAddition:
      'For each candidate, estimate the user-visible or business impact if it ships, and the engineering effort required. Classic prioritization — help the user find their sweeps and avoid their slogs.',
    axisA: {
      label: 'Impact',
      rubricSentence: '0 = detour (negligible user or business value), 100 = sweep (high leverage across many users or workflows).',
    },
    axisB: {
      label: 'Effort',
      rubricSentence: '0 = slog (weeks of difficult work with uncertain outcome), 100 = polish (hours of focused work with clear outcome).',
    },
    quadrantLabels: {
      highHigh: 'Sweep',
      highLow: 'Slog',
      lowHigh: 'Polish',
      lowLow: 'Detour',
    },
  },

  {
    id: 'conviction-reversibility',
    name: 'Conviction × Reversibility',
    group: 'building',
    generationPromptAddition:
      'For each candidate, assess how confident you should be that it\'s the right move, and how easily it can be undone if wrong. Help the user know when to act boldly and when to run a cheap experiment first.',
    axisA: {
      label: 'Conviction',
      rubricSentence: '0 = low confidence (many unknowns, weak signal), 100 = high confidence (strong evidence, clear mental model).',
    },
    axisB: {
      label: 'Reversibility',
      rubricSentence: '0 = bold bet (hard to undo once shipped or committed), 100 = cheap experiment (easy to try, easy to revert).',
    },
    quadrantLabels: {
      highHigh: 'Just do it',
      highLow: 'Sleep on it',
      lowHigh: 'Bold bet',
      lowLow: 'Cheap experiment',
    },
  },

  // ── Risk group ──────────────────────────────────────────────────────────

  {
    id: 'exposure-hardening',
    name: 'Exposure × Hardening Effort',
    group: 'risk',
    generationPromptAddition:
      'For each candidate, identify a security or reliability surface in the codebase. Score how exposed it is (how easy to exploit or how likely to cause an incident) and how much effort it would take to harden it. Help the user find their highest-ROI hardening work.',
    axisA: {
      label: 'Exposure',
      rubricSentence: '0 = don\'t bother (theoretical risk, no real-world path to exploit), 100 = why haven\'t we (obvious attack surface, actively dangerous).',
    },
    axisB: {
      label: 'Hardening Effort',
      rubricSentence: '0 = plan a sprint (significant investment needed), 100 = sweep nearby (can harden in a PR or two).',
    },
    quadrantLabels: {
      highHigh: 'Why haven\'t we',
      highLow: 'Plan a sprint',
      lowHigh: 'Sweep nearby',
      lowLow: 'Don\'t bother',
    },
  },

  {
    id: 'blast-radius-detection',
    name: 'Blast Radius × Detection Difficulty',
    group: 'risk',
    generationPromptAddition:
      'For each candidate, identify a failure mode or attack scenario. Score how bad the outcome would be if it happened, and how hard it would be to detect or debug. Help the user find their scariest invisible risks.',
    axisA: {
      label: 'Blast Radius',
      rubricSentence: '0 = fine (recoverable, limited scope), 100 = career-ender (catastrophic data loss, major breach, or outage).',
    },
    axisB: {
      label: 'Detection Difficulty',
      rubricSentence: '0 = scary but visible (immediately obvious when it happens), 100 = debugging rabbit hole (silent failure, hard to trace).',
    },
    quadrantLabels: {
      highHigh: 'Career-ender',
      highLow: 'Scary but visible',
      lowHigh: 'Debugging rabbit hole',
      lowLow: 'Fine',
    },
  },
];

export const DEFAULT_FRAMES_BY_ID: Record<string, Frame> = Object.fromEntries(
  DEFAULT_FRAMES.map((f) => [f.id, f]),
);

export function getFrame(id: string): Frame | undefined {
  return DEFAULT_FRAMES_BY_ID[id];
}

export function getFramesByGroup(group: 'building' | 'risk'): Frame[] {
  return DEFAULT_FRAMES.filter((f) => f.group === group);
}
