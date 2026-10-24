import { vi } from 'vitest';
import { AuditCandidate, AuditFilter, DEFAULT_AUDIT_FILTER } from '../../src/model/audit';
import { GenderCategory, isLikelyGender } from '../../src/model/gender';
import { UserNode } from '../../src/model/user';
import { createDemoCandidates, createDemoDataset, DemoDataset } from '../../src/preview/demo-data';
import { ReviewScreenProps } from '../../src/components/ReviewScreen';

/** Fresh demo dataset (never shared between tests). */
export function demoDataset(): DemoDataset {
  return createDemoDataset();
}

export function findUser(candidates: readonly AuditCandidate[], username: string): UserNode {
  for (const candidate of candidates) {
    if (candidate.user.username === username) {
      return candidate.user;
    }
  }
  throw new Error(`No demo candidate for username ${username}`);
}

/**
 * Deterministic synthetic likely-women the viewer follows, repeated until
 * `count` rows exist. Used to exercise pagination (>50 rows) without network.
 */
export function repeatedWomenFollowing(count: number): readonly AuditCandidate[] {
  const seeds = createDemoCandidates().filter(
    candidate =>
      candidate.relationship !== 'follower' &&
      candidate.gender !== null &&
      isLikelyGender(candidate.gender, 'female', 0.9),
  );
  const rows: AuditCandidate[] = [];
  let index = 0;
  while (rows.length < count) {
    const seed = seeds[index % seeds.length];
    const id = `repeat-${String(index)}-${seed.user.id}`;
    rows.push({
      user: { ...seed.user, id, username: `${seed.user.username}.r${String(index)}` },
      relationship: seed.relationship,
      gender: seed.gender,
    });
    index += 1;
  }
  return rows;
}

/** The default filter with a different nuke category (female by default). */
export function filterForTarget(target: GenderCategory): AuditFilter {
  return { ...DEFAULT_AUDIT_FILTER, targetCategory: target };
}

/** Default props for ReviewScreen; override only what a test cares about. */
export function reviewProps(overrides: Partial<ReviewScreenProps> = {}): ReviewScreenProps {
  const dataset = demoDataset();
  return {
    lang: 'en',
    candidates: dataset.candidates,
    whitelistedResults: dataset.whitelistedResults,
    selectedIds: [],
    currentTab: 'target-following',
    searchTerm: '',
    filter: DEFAULT_AUDIT_FILTER,
    scanComplete: true,
    followingComplete: true,
    followersComplete: true,
    classificationFailures: 0,
    totalFetched: dataset.candidates.length,
    classifierVersion: 'demo-names:v1',
    demo: true,
    fromCache: false,
    onTabChange: vi.fn(),
    onSearchChange: vi.fn(),
    onFilterChange: vi.fn(),
    onSelectionChange: vi.fn(),
    onToggleWhitelist: vi.fn(),
    onDryRun: vi.fn(),
    onLiveRun: vi.fn(),
    onBack: vi.fn(),
    onLanguageChange: vi.fn(),
    onOpenSettings: vi.fn(),
    onCopy: vi.fn(),
    onExportJson: vi.fn(),
    onExportCsv: vi.fn(),
    ...overrides,
  };
}
