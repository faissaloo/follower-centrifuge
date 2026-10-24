import React, { useEffect, useState } from 'react';
import { AuditCandidate, AuditFilter, AuditTab } from '../model/audit';
import { GenderCategory } from '../model/gender';
import { UserNode } from '../model/user';
import {
  getCandidatesForDisplay,
  getCurrentAuditPage,
  getEligibleTargets,
  getMaxAuditPage,
  isConfidentTarget,
  summarizeAudit,
} from '../utils/audit-display';
import { Language, t } from '../utils/i18n';
import { isProtectedByWhitelist } from '../utils/whitelist-match';
import { AuditCandidateRow } from './AuditCandidateRow';
import { Pagination } from './AuditPrimitives';
import { LiveApprovalDialog } from './LiveApprovalDialog';
import { Toolbar } from './Toolbar';
import { WarningIcon } from './icons/WarningIcon';
import { WizardSteps } from './WizardSteps';

export interface ClassifierAttribution {
  /** Main provider configured for this review. */
  readonly primary: 'typesafe' | 'deepseek' | 'demo';
  /** Fallback provider, when one is configured. */
  readonly fallback: 'deepseek' | null;
  /** Vision model used for the profile-photo pass, when enabled. */
  readonly visionModel?: string;
  readonly photoEnabled: boolean;
}

export interface ReviewScreenProps {
  readonly lang: Language;
  readonly candidates: readonly AuditCandidate[];
  readonly whitelistedResults: readonly UserNode[];
  readonly selectedIds: readonly string[];
  readonly currentTab: AuditTab;
  readonly searchTerm: string;
  readonly filter: AuditFilter;
  /** Whether the whole audit (both lists + classification) completed. */
  readonly scanComplete: boolean;
  readonly followingComplete: boolean;
  readonly followersComplete: boolean;
  readonly classificationFailures: number;
  /** First classifier transport error verbatim (CSP/relay problems). */
  readonly classifierError?: string;
  readonly totalFetched: number;
  readonly classifierVersion: string;
  /** True when the built-in synthetic demo dataset is being reviewed. */
  readonly demo: boolean;
  /** True when this review was restored from the local cache (live locked). */
  readonly fromCache: boolean;
  readonly onTabChange: (tab: AuditTab) => void;
  readonly onSearchChange: (term: string) => void;
  readonly onFilterChange: (filter: AuditFilter) => void;
  readonly onSelectionChange: (ids: readonly string[]) => void;
  readonly onToggleWhitelist: (user: UserNode) => void;
  /** Set by App after a completed dry run: open the typed live-approval dialog. */
  readonly requestLiveApproval?: boolean;
  readonly onLiveApprovalRequestHandled?: () => void;
  /** Build and execute a dry-run plan (Lead wires plan building). */
  readonly onDryRun: () => void;
  /** Build and execute a live plan with the typed approval phrase. */
  readonly onLiveRun: (typedConfirmation: string, targetIds: readonly string[]) => void;
  readonly onBack: () => void;
  readonly onLanguageChange: (lang: Language) => void;
  readonly onOpenSettings: () => void;
  readonly onCopy: () => void;
  readonly onExportJson: () => void;
  readonly onExportCsv: () => void;
  readonly classifierAttribution?: ClassifierAttribution;
  /** Also allow removing followers-only accounts (App enables this). */
  readonly includeFollowers?: boolean;
}

/**
 * Target-gender relationship tabs first, then the "other / uncertain" bucket
 * (machine/organization/ambiguous + weak guesses), then protection.
 */
const TABS: readonly AuditTab[] = ['target-following', 'target-followers', 'uncertain', 'whitelisted'];

/**
 * Confidence is a free 0–100% number box, not a dropdown: a 50% floor was
 * arbitrary, and reviewers may deliberately widen the net below it.
 */
function ConfidenceThresholdInput({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (minimumConfidence: number) => void;
}): React.JSX.Element {
  const percentValue = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const [draft, setDraft] = useState<string>(String(percentValue));
  useEffect(() => {
    setDraft(String(percentValue));
  }, [percentValue]);
  return (
    <span className='wa-filters__confidence'>
      <input
        type='number'
        className='wa-input wa-input--confidence'
        aria-label={label}
        min={0}
        max={100}
        step={1}
        inputMode='numeric'
        value={draft}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          const raw = event.currentTarget.value;
          setDraft(raw);
          if (raw.trim() === '') {
            return;
          }
          const percent = Number(raw);
          if (Number.isFinite(percent)) {
            onChange(Math.max(0, Math.min(1, percent / 100)));
          }
        }}
        onBlur={() => setDraft(String(percentValue))}
      />
      <span className='wa-filters__confidence-suffix' aria-hidden='true'>%</span>
    </span>
  );
}

const CATEGORY_LABEL_KEYS: Record<GenderCategory, 'categoryFemale' | 'categoryMale' | 'categoryMachine' | 'categoryOrganization' | 'categoryAmbiguous'> = {
  female: 'categoryFemale',
  male: 'categoryMale',
  machine: 'categoryMachine',
  organization: 'categoryOrganization',
  ambiguous: 'categoryAmbiguous',
};

/** Short category label used as the %s in tab/summary copy. */
function categoryLabel(lang: Language, category: GenderCategory): string {
  return t(lang, CATEGORY_LABEL_KEYS[category]);
}

/** Category-aware label for a review tab. */
function tabLabel(lang: Language, target: GenderCategory, tab: AuditTab): string {
  switch (tab) {
    case 'target-following':
      return t(lang, 'tabTargetFollowing', categoryLabel(lang, target));
    case 'target-followers':
      return t(lang, 'tabTargetFollowers', categoryLabel(lang, target));
    case 'uncertain':
      return t(lang, 'tabOtherUncertain');
    case 'whitelisted':
      return t(lang, 'tabWhitelisted');
    default:
      throw new Error(`Unhandled audit tab: ${String(tab)}`);
  }
}

function withId(ids: readonly string[], id: string, add: boolean): readonly string[] {
  const present = ids.indexOf(id) !== -1;
  if (add === present) {
    return ids;
  }
  return add ? [...ids, id] : ids.filter(existing => existing !== id);
}

/**
 * Review screen: tabs, filters, paginated candidate rows, selection and the
 * safe/dangerous action bar. All state is passed in and every mutation is a
 * callback, so App remains the single source of truth.
 */
export const ReviewScreen = ({
  lang,
  candidates,
  whitelistedResults,
  selectedIds,
  currentTab,
  searchTerm,
  filter,
  scanComplete,
  followingComplete,
  followersComplete,
  classificationFailures,
  classifierError,
  totalFetched,
  classifierVersion,
  demo,
  fromCache,
  onTabChange,
  onSearchChange,
  onFilterChange,
  onSelectionChange,
  onToggleWhitelist,
  requestLiveApproval = false,
  onLiveApprovalRequestHandled,
  onDryRun,
  onLiveRun,
  onBack,
  onLanguageChange,
  onOpenSettings,
  onCopy,
  onExportJson,
  onExportCsv,
  classifierAttribution = { primary: 'typesafe', fallback: 'deepseek', photoEnabled: false },
  includeFollowers = false,
}: ReviewScreenProps) => {
  const [page, setPage] = useState(1);
  const [approvalOpen, setApprovalOpen] = useState(false);

  const classifierRole = (source: 'typesafe' | 'deepseek' | 'demo'): string => {
    if (source === 'demo' || classifierAttribution.primary === 'demo') {
      return t(lang, 'classifierViaDemo');
    }
    if (source === classifierAttribution.primary) {
      return t(lang, 'classifierViaMain');
    }
    if (source === classifierAttribution.fallback) {
      return t(lang, 'classifierViaFallback');
    }
    return t(lang, 'classifierViaFallback');
  };

  useEffect(() => {
    if (!requestLiveApproval) {
      return;
    }
    setApprovalOpen(true);
    onLiveApprovalRequestHandled?.();
  }, [onLiveApprovalRequestHandled, requestLiveApproval]);

  const visibleCandidates = getCandidatesForDisplay(candidates, whitelistedResults, currentTab, searchTerm, filter);
  const maxPage = getMaxAuditPage(visibleCandidates);
  const safePage = page > maxPage ? maxPage : page;
  const pageCandidates = getCurrentAuditPage(visibleCandidates, safePage);
  const summary = summarizeAudit(candidates, whitelistedResults, filter);
  const eligible = getEligibleTargets(
    candidates,
    whitelistedResults,
    filter.minimumConfidence,
    filter.targetCategory,
    includeFollowers,
    filter.includeAmbiguous,
  );
  const classifiable = candidates.length;

  const selectedSet = new Set(selectedIds);
  const eligibleIdList = eligible.map(candidate => candidate.user.id);
  const eligibleIdSet = new Set(eligibleIdList);
  const isWhitelisted = (user: UserNode): boolean => isProtectedByWhitelist(user, whitelistedResults);

  const pageEligibleIds = pageCandidates
    .filter(candidate => eligibleIdSet.has(candidate.user.id))
    .map(candidate => candidate.user.id);
  const visibleEligibleIds = visibleCandidates
    .filter(candidate => eligibleIdSet.has(candidate.user.id))
    .map(candidate => candidate.user.id);

  const pageEligibleSelected = pageEligibleIds.filter(id => selectedSet.has(id)).length;
  const allEligibleSelected = visibleEligibleIds.filter(id => selectedSet.has(id)).length;
  const selectedTargets = eligible.filter(candidate => selectedSet.has(candidate.user.id));
  const eligibleSelection = selectedTargets.length;
  const classificationHasRun = candidates.some(candidate => candidate.gender !== null);

  const tabCount = (tab: AuditTab): number => getCandidatesForDisplay(candidates, whitelistedResults, tab, '', filter).length;

  let incompleteListKey: 'incompleteFollowing' | 'incompleteFollowers' | 'incompleteBoth' = 'incompleteBoth';
  if (followingComplete !== followersComplete) {
    incompleteListKey = followingComplete ? 'incompleteFollowers' : 'incompleteFollowing';
  }

  let liveDisabledReason: string | undefined;
  if (!scanComplete) {
    liveDisabledReason = t(lang, 'liveRunLockedIncomplete');
  } else if (fromCache) {
    liveDisabledReason = t(lang, 'liveRunLockedCached');
  } else if (demo) {
    liveDisabledReason = t(lang, 'liveRunBlocked');
  } else if (!classificationHasRun) {
    liveDisabledReason = t(lang, 'liveRunLockedNoClassification');
  } else if (eligibleSelection === 0) {
    liveDisabledReason = t(lang, 'liveRunLockedNoTargets');
  }

  const dryDisabledReason = eligibleSelection === 0 ? t(lang, 'dryRunLockedNoTargets') : undefined;

  const lockedExplanation = (candidate: AuditCandidate): string | undefined => {
    if (isWhitelisted(candidate.user)) {
      return t(lang, 'rowLockedProtected');
    }
    if (candidate.relationship === 'follower' || !candidate.user.followed_by_viewer) {
      return t(lang, 'rowLockedFollowerOnly');
    }
    return isConfidentTarget(candidate, filter)
      ? undefined
      : t(lang, 'rowLockedNotTargetCategory', categoryLabel(lang, filter.targetCategory));
  };

  const selectIds = (add: boolean, ids: readonly string[]): void => {
    const next: string[] = [];
    for (const id of selectedIds) {
      if (add || ids.indexOf(id) === -1) {
        next.push(id);
      }
    }
    if (add) {
      for (const id of ids) {
        if (next.indexOf(id) === -1) {
          next.push(id);
        }
      }
    }
    onSelectionChange(next);
  };

  const changeTab = (tab: AuditTab): void => {
    if (tab === currentTab) {
      return;
    }
    setPage(1);
    onTabChange(tab);
  };

  const changeFilter = (next: AuditFilter): void => {
    setPage(1);
    onFilterChange(next);
  };


  return (
    <section className='wa-screen wa-review'>
      <Toolbar
        lang={lang}
        onLanguageChange={onLanguageChange}
        onOpenSettings={onOpenSettings}
        onBack={onBack}
        mode={null}
        demo={demo}
        searchValue={searchTerm}
        onSearchChange={(value: string) => {
          setPage(1);
          onSearchChange(value);
        }}
        searchPlaceholder={t(lang, 'searchPlaceholder')}
        showSelection
        selectionDisabled={false}
        selectPageChecked={pageEligibleIds.length > 0 && pageEligibleSelected === pageEligibleIds.length}
        selectPageIndeterminate={pageEligibleSelected > 0 && pageEligibleSelected < pageEligibleIds.length}
        onToggleSelectPage={(checked: boolean) => selectIds(checked, pageEligibleIds)}
        selectAllChecked={visibleEligibleIds.length > 0 && allEligibleSelected === visibleEligibleIds.length}
        selectAllIndeterminate={allEligibleSelected > 0 && allEligibleSelected < visibleEligibleIds.length}
        onToggleSelectAll={(checked: boolean) => selectIds(checked, visibleEligibleIds)}
        onCopy={onCopy}
        onExportJson={onExportJson}
        onExportCsv={onExportCsv}
        exportsDisabled={candidates.length === 0}
      />

      <div className='wa-review__body'>
        <main className='wa-review__main'>
          <div className='wa-review__wizard'>
            <WizardSteps lang={lang} current={2} />
            <h1 className='wa-review__title'>{t(lang, 'reviewTitle')}</h1>
          </div>

          {!scanComplete && (
            <div className='wa-banner wa-banner--warning' role='alert'>
              <WarningIcon />
              <div>
                <strong>{t(lang, 'scanIncompleteTitle')}</strong>
                <p>{t(lang, 'scanIncompleteBody', t(lang, incompleteListKey))}</p>
              </div>
            </div>
          )}
          {classifierError !== undefined && (
            <div className='wa-banner wa-banner--warning' role='alert'>
              <WarningIcon />
              <div>
                <strong>{t(lang, 'classifierUnavailableTitle')}</strong>
                <p>{t(lang, 'classifierUnavailableBody', classifierError)}</p>
                <p>{t(lang, 'relayHint')}</p>
                <button type='button' className='wa-btn wa-btn--ghost wa-btn--small' onClick={onOpenSettings}>
                  {t(lang, 'advancedLabel')}
                </button>
              </div>
            </div>
          )}
          {classificationFailures > 0 && (
            <div className='wa-banner wa-banner--info' role='status'>
              {t(lang, 'classificationFailuresNotice', classificationFailures)}
            </div>
          )}
          {scanComplete && !classificationHasRun && classifiable > 0 && (
            <div className='wa-banner wa-banner--warning' role='alert'>
              {t(lang, 'classificationMissingNotice')}
            </div>
          )}
          {demo && (
            <div className='wa-banner wa-banner--demo' role='status'>
              {t(lang, 'demoNotice')}
            </div>
          )}
          {fromCache && (
            <div className='wa-banner wa-banner--info' role='status'>
              {t(lang, 'cachedReviewNotice')}
            </div>
          )}

          <div className='wa-tabs' role='tablist' aria-label={t(lang, 'reviewTitle')}>
            {TABS.map(tab => (
              <button
                key={tab}
                type='button'
                role='tab'
                aria-selected={tab === currentTab}
                className={`wa-tab${tab === currentTab ? ' wa-tab--active' : ''}`}
                onClick={() => changeTab(tab)}
              >
                <span className='wa-tab__label'>{tabLabel(lang, filter.targetCategory, tab)}</span>
                <span className='wa-tab__count'>{String(tabCount(tab))}</span>
              </button>
            ))}
          </div>

          <div className='wa-filters'>
            <span className='wa-filters__target'>
              {t(lang, 'reviewNuking', categoryLabel(lang, filter.targetCategory))}
            </span>
            <label className='wa-filters__field'>
              <span>{t(lang, 'minimumConfidence')}</span>
              <ConfidenceThresholdInput
                label={t(lang, 'minimumConfidence')}
                value={filter.minimumConfidence}
                onChange={minimumConfidence => changeFilter({ ...filter, minimumConfidence })}
              />
            </label>
            <label className='wa-checkbox'>
              <input
                type='checkbox'
                checked={filter.showPrivate}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  changeFilter({ ...filter, showPrivate: event.currentTarget.checked })
                }
              />
              <span>{t(lang, 'showPrivate')}</span>
            </label>
            <label className='wa-checkbox'>
              <input
                type='checkbox'
                checked={filter.includeAmbiguous}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  changeFilter({ ...filter, includeAmbiguous: event.currentTarget.checked })
                }
              />
              <span>{t(lang, 'includeUnsure')}</span>
            </label>
            <label className='wa-checkbox'>
              <input
                type='checkbox'
                checked={filter.showVerified}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  changeFilter({ ...filter, showVerified: event.currentTarget.checked })
                }
              />
              <span>{t(lang, 'showVerified')}</span>
            </label>
            <span className='wa-filters__note'>{t(lang, 'guessEstimateNote')}</span>
          </div>

          {currentTab === 'whitelisted' && <p className='wa-review__hint'>{t(lang, 'protectedNote')}</p>}

          {pageCandidates.length === 0 ? (
            <p className='wa-empty' role='status'>
              {t(lang, 'noUsersFound')}
            </p>
          ) : (
            <ul className='wa-row-list' aria-label={tabLabel(lang, filter.targetCategory, currentTab)}>
              {pageCandidates.map(candidate => (
                <AuditCandidateRow
                  key={candidate.user.id}
                  lang={lang}
                  candidate={candidate}
                  selected={selectedSet.has(candidate.user.id)}
                  selectable={eligibleIdSet.has(candidate.user.id)}
                  lockedExplanation={eligibleIdSet.has(candidate.user.id) ? undefined : lockedExplanation(candidate)}
                  whitelisted={isWhitelisted(candidate.user)}
                  classifierRoleLabel={
                    candidate.gender === null ? undefined : classifierRole(candidate.gender.source)
                  }
                  classifierTitle={
                    candidate.gender === null
                      ? undefined
                      : t(
                          lang,
                          'classifierRoleTitle',
                          classifierRole(candidate.gender.source).replace(/^via |^vía /, ''),
                          `${candidate.gender.source} · ${candidate.gender.model}`,
                        )
                  }
                  onToggleSelected={(selected: boolean) =>
                    onSelectionChange(withId(selectedIds, candidate.user.id, selected))
                  }
                  onToggleWhitelist={() => onToggleWhitelist(candidate.user)}
                />
              ))}
            </ul>
          )}

          {visibleCandidates.length > 0 && (
            <Pagination
              lang={lang}
              page={safePage}
              maxPage={maxPage}
              onPageChange={setPage}
              shownCount={pageCandidates.length}
              totalCount={visibleCandidates.length}
            />
          )}
        </main>

        <aside className='wa-review__aside'>
          <section className='wa-panel' aria-labelledby='wa-summary-title'>
            <h2 id='wa-summary-title' className='wa-panel__title'>
              {t(lang, 'summaryTitle')}
            </h2>
            <dl className='wa-summary'>
              <div className='wa-summary__item'>
                <dt>{t(lang, 'summaryTargetFollowing', categoryLabel(lang, filter.targetCategory))}</dt>
                <dd>{String(summary.targetFollowing)}</dd>
              </div>
              <div className='wa-summary__item'>
                <dt>{t(lang, 'summaryTargetFollowers', categoryLabel(lang, filter.targetCategory))}</dt>
                <dd>{String(summary.targetFollowers)}</dd>
              </div>
              <div className='wa-summary__item'>
                <dt>{t(lang, 'summaryTargetMutual')}</dt>
                <dd>{String(summary.targetMutual)}</dd>
              </div>
              <div className='wa-summary__item'>
                <dt>{t(lang, 'summaryOtherUncertain')}</dt>
                <dd>{String(summary.uncertain)}</dd>
              </div>
              <div className='wa-summary__item wa-summary__item--accent'>
                <dt>{t(lang, 'summaryEligible')}</dt>
                <dd>{String(summary.eligibleForUnfollow)}</dd>
              </div>
              <div className='wa-summary__item'>
                <dt>{t(lang, 'summaryTotal')}</dt>
                <dd>{String(totalFetched)}</dd>
              </div>
            </dl>
            {classifierVersion !== '' && (
              <p className='wa-panel__meta'>{t(lang, 'classifierVersionNote', classifierVersion)}</p>
            )}
          </section>

          <section className='wa-panel wa-panel--selection' aria-labelledby='wa-selection-title'>
            <h2 id='wa-selection-title' className='wa-panel__title'>
              {t(lang, 'selectionTitle')}
            </h2>
            <p className='wa-selection__count' data-testid='selected-count'>
              {t(lang, 'selectedCount', selectedIds.length)}
            </p>
            <p className='wa-selection__count wa-selection__count--eligible' data-testid='eligible-count'>
              {t(lang, 'eligibleSelection', eligibleSelection)}
            </p>
            <p className='wa-panel__meta'>{t(lang, 'eligibleNote')}</p>
            {selectedIds.length === 0 && <p className='wa-panel__meta'>{t(lang, 'notSelectedYet')}</p>}
            <button
              type='button'
              className='wa-btn wa-btn--ghost wa-btn--small'
              disabled={selectedIds.length === 0}
              onClick={() => onSelectionChange([])}
            >
              {t(lang, 'clearSelection')}
            </button>
          </section>

          <section className='wa-panel wa-panel--actions' aria-labelledby='wa-actions-title'>
            <h2 id='wa-actions-title' className='wa-panel__title'>
              {t(lang, 'actionsTitle')}
            </h2>
            <button
              type='button'
              className='wa-btn wa-btn--primary wa-btn--block'
              disabled={dryDisabledReason !== undefined}
              title={dryDisabledReason}
              onClick={onDryRun}
            >
              🧪 {t(lang, 'dryRunAction')}
            </button>
            <p className='wa-panel__meta'>{dryDisabledReason === undefined ? t(lang, 'dryRunHint') : dryDisabledReason}</p>

            <button
              type='button'
              className='wa-btn wa-btn--danger wa-btn--block'
              disabled={liveDisabledReason !== undefined}
              title={liveDisabledReason}
              onClick={() => setApprovalOpen(true)}
            >
              ⚠️ {t(lang, 'liveRunAction')}
            </button>
            <p className={`wa-panel__meta${liveDisabledReason !== undefined ? ' wa-panel__meta--locked' : ' wa-panel__meta--danger'}`}>
              {liveDisabledReason === undefined ? t(lang, 'liveRunHint') : liveDisabledReason}
            </p>
          </section>
        </aside>
      </div>

      <LiveApprovalDialog
        open={approvalOpen}
        lang={lang}
        targets={selectedTargets.map(candidate => candidate.user)}
        onCancel={() => setApprovalOpen(false)}
        onConfirm={(typedConfirmation: string) => {
          setApprovalOpen(false);
          // Bind the approval to the exact accounts the dialog displayed.
          onLiveRun(typedConfirmation, selectedTargets.map(candidate => candidate.user.id));
        }}
      />
    </section>
  );
};
