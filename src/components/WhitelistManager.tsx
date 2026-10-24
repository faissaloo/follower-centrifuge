import React, { useRef, useState } from 'react';
import { Typename, UserNode } from '../model/user';
import { exportWhitelist, importWhitelist, mergeWhitelists } from '../utils/whitelist-manager';
import { Language, t } from '../utils/i18n';

export interface WhitelistManagerProps {
  readonly whitelistedUsers: readonly UserNode[];
  /** Called with the complete next protected list; persistence is App's job. */
  readonly onWhitelistUpdate: (users: readonly UserNode[]) => void;
  readonly lang: Language;
}

interface ManagerMessage {
  readonly type: 'success' | 'error';
  readonly text: string;
}

function avatarFor(username: string): string {
  return `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(username)}&backgroundColor=0f172a,1f2937,312e81&fontFamily=Verdana`;
}

function pastedUser(username: string): UserNode {
  const id = `pasted_${username}_${Date.now()}`;
  return {
    id,
    username,
    full_name: username,
    profile_pic_url: avatarFor(username),
    is_private: false,
    is_verified: false,
    followed_by_viewer: true,
    follows_viewer: false,
    requested_by_viewer: false,
    reel: {
      id,
      expiring_at: 0,
      has_pride_media: false,
      latest_reel_media: 0,
      seen: null,
      owner: {
        __typename: Typename.GraphUser,
        id,
        profile_pic_url: avatarFor(username),
        username,
      },
    },
  };
}

/**
 * Management of the protected ("whitelist") accounts: export/import JSON,
 * bulk-paste usernames and clear the list. All changes flow through
 * `onWhitelistUpdate`, never touching storage directly.
 */
export const WhitelistManager = ({ whitelistedUsers, onWhitelistUpdate, lang }: WhitelistManagerProps) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('merge');
  const [message, setMessage] = useState<ManagerMessage | null>(null);
  const [showPasteArea, setShowPasteArea] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const handleExport = (): void => {
    exportWhitelist(whitelistedUsers);
    setMessage({ type: 'success', text: t(lang, 'whitelistExported') });
  };

  const handleImportClick = (): void => {
    if (fileInputRef.current !== null) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files === null ? undefined : event.currentTarget.files[0];
    if (file === undefined) {
      return;
    }
    importWhitelist(
      file,
      (importedUsers: readonly UserNode[]) => {
        if (importMode === 'merge') {
          const merged = mergeWhitelists(whitelistedUsers, importedUsers);
          const newCount = merged.length - whitelistedUsers.length;
          setMessage({ type: 'success', text: t(lang, 'whitelistImportMerged', newCount, importedUsers.length - newCount) });
          onWhitelistUpdate(merged);
        } else {
          setMessage({ type: 'success', text: t(lang, 'whitelistImportReplaced', importedUsers.length) });
          onWhitelistUpdate(importedUsers);
        }
      },
      (errorMessage: string) => {
        setMessage({ type: 'error', text: errorMessage });
      },
    );
    event.currentTarget.value = '';
  };

  const handleClear = (): void => {
    if (!confirm(t(lang, 'clearWhitelistConfirm'))) {
      return;
    }
    onWhitelistUpdate([]);
    setMessage({ type: 'success', text: t(lang, 'whitelistCleared') });
  };

  const handlePasteSubmit = (): void => {
    const rawTokens = pasteText
      .split(/[\s,;\n\r\t]+/)
      .map(token => token.replace(/^@+/, '').trim().toLowerCase())
      .filter(token => token.length > 0 && /^[a-zA-Z0-9._]+$/.test(token));
    if (rawTokens.length === 0) {
      setMessage({ type: 'error', text: t(lang, 'noValidUsernamesFound') });
      return;
    }
    const uniqueUsernames = Array.from(new Set(rawTokens));
    const existingUsernames = new Set(whitelistedUsers.map(user => user.username.toLowerCase()));
    const toAdd = uniqueUsernames.filter(username => !existingUsernames.has(username));
    if (toAdd.length === 0) {
      setMessage({ type: 'success', text: t(lang, 'pastedUsersAlreadyExist') });
      return;
    }
    onWhitelistUpdate([...whitelistedUsers, ...toAdd.map(pastedUser)]);
    setPasteText('');
    setShowPasteArea(false);
    setMessage({ type: 'success', text: t(lang, 'pastedUsersAdded', toAdd.length) });
  };

  const countLabel = `${String(whitelistedUsers.length)} ${
    whitelistedUsers.length === 1 ? t(lang, 'userSingular') : t(lang, 'userPlural')
  }`;

  return (
    <div className='wa-whitelist'>
      <div className='wa-whitelist__header'>
        <h4>{t(lang, 'whitelistTitle')}</h4>
        <span className='wa-whitelist__count'>{countLabel}</span>
      </div>

      <p className='wa-whitelist__description'>{t(lang, 'whitelistDescription')}</p>

      {message !== null && (
        <div className={`wa-whitelist__message wa-whitelist__message--${message.type}`} role='status'>
          {message.text}
        </div>
      )}

      {whitelistedUsers.length === 0 && <p className='wa-whitelist__empty'>{t(lang, 'whitelistEmpty')}</p>}

      <div className='wa-whitelist__actions'>
        <button
          type='button'
          className='wa-btn wa-btn--ghost wa-btn--small'
          onClick={handleExport}
          disabled={whitelistedUsers.length === 0}
          title={whitelistedUsers.length === 0 ? t(lang, 'whitelistNoUsers') : t(lang, 'exportWhitelist')}
        >
          {t(lang, 'exportWhitelist')}
        </button>

        <div className='wa-whitelist__import'>
          <div className='wa-whitelist__modes' role='group' aria-label={t(lang, 'importWhitelist')}>
            <label className='wa-radio'>
              <input
                type='radio'
                name='importMode'
                value='merge'
                checked={importMode === 'merge'}
                onChange={() => setImportMode('merge')}
              />
              {t(lang, 'mergeWhitelist')}
            </label>
            <label className='wa-radio'>
              <input
                type='radio'
                name='importMode'
                value='replace'
                checked={importMode === 'replace'}
                onChange={() => setImportMode('replace')}
              />
              {t(lang, 'replaceWhitelist')}
            </label>
          </div>

          <button
            type='button'
            className='wa-btn wa-btn--ghost wa-btn--small'
            onClick={handleImportClick}
            title={t(lang, 'importWhitelist')}
          >
            {t(lang, 'importWhitelist')}
          </button>
          <input
            ref={fileInputRef}
            type='file'
            accept='.json'
            onChange={handleFileChange}
            style={{ display: 'none' }}
            aria-label={t(lang, 'importWhitelist')}
          />
        </div>

        <button
          type='button'
          className='wa-btn wa-btn--ghost wa-btn--small'
          onClick={() => setShowPasteArea(!showPasteArea)}
          title={t(lang, 'pasteWhitelist')}
        >
          {t(lang, 'pasteWhitelist')}
        </button>

        <button
          type='button'
          className='wa-btn wa-btn--danger-text wa-btn--small'
          onClick={handleClear}
          disabled={whitelistedUsers.length === 0}
          title={t(lang, 'clearWhitelist')}
        >
          {t(lang, 'clearWhitelist')}
        </button>
      </div>

      {showPasteArea && (
        <div className='wa-whitelist__paste'>
          <textarea
            className='wa-textarea'
            placeholder={t(lang, 'pasteWhitelistPlaceholder')}
            aria-label={t(lang, 'pasteWhitelistPlaceholder')}
            value={pasteText}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setPasteText(event.currentTarget.value)}
            rows={3}
          />
          <button type='button' className='wa-btn wa-btn--ghost wa-btn--small' onClick={handlePasteSubmit}>
            {t(lang, 'addPastedToWhitelist')}
          </button>
        </div>
      )}

      <p className='wa-whitelist__tip'>{t(lang, 'whitelistTip')}</p>
    </div>
  );
};
