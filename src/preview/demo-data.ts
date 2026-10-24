/**
 * Built-in demo dataset used by the local preview (`?preview=review`) and by UI
 * tests. It is entirely synthetic: no real account, no network, no images.
 *
 * The set is intentionally varied so the review UI can be exercised for:
 *  - likely female accounts the viewer follows (unfollow-eligible),
 *  - likely female accounts who follow the viewer only (shown, never eligible),
 *  - mutually-followed accounts (both lists),
 *  - likely male accounts, machine accounts, organizations and ambiguous names
 *    (never show up as target tabs; machine/organization/ambiguous always land
 *    in the "other / uncertain" tab and are never unfollow-eligible),
 *  - low-confidence guesses (other / uncertain tab),
 *  - private, verified and no-profile-picture accounts,
 *  - whitelisted accounts that must stay protected.
 */
import { AuditCandidate, FollowRelationship } from '../model/audit';
import { GenderGuess } from '../model/gender';
import { Typename, UserNode } from '../model/user';

export const DEMO_CLASSIFIER_VERSION = 'demo-names:v2';
const DEMO_TIMESTAMP = 1735689600000;

function avatar(seed: string, background: string): string {
  const initials = seed
    .split(/[^a-zA-Z]+/)
    .filter(part => part !== '')
    .slice(0, 2)
    .map(part => part[0].toUpperCase())
    .join('');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
    `<rect width="96" height="96" rx="48" fill="${background}"/>` +
    `<text x="48" y="58" font-family="Verdana" font-size="32" fill="#f8fafc" text-anchor="middle">${initials}</text>` +
    '</svg>';
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

interface DemoSpec {
  readonly id: string;
  readonly username: string;
  readonly fullName: string;
  readonly relationship: FollowRelationship;
  readonly gender: GenderGuess['gender'];
  readonly confidence: number;
  readonly reason: string;
  readonly isPrivate?: boolean;
  readonly isVerified?: boolean;
  readonly noPicture?: boolean;
}

const DEMO_SPECS: readonly DemoSpec[] = [
  { id: 'demo-1', username: 'alina.frames', fullName: 'Alina Moreno', relationship: 'following', gender: 'female', confidence: 0.97, reason: 'Alina is a conventionally feminine given name' },
  { id: 'demo-2', username: 'brassandbone', fullName: 'Thea Walsh', relationship: 'mutual', gender: 'female', confidence: 0.93, reason: 'Thea is a conventionally feminine given name', isPrivate: true },
  { id: 'demo-3', username: 'citrus.archive', fullName: 'Mara Kim', relationship: 'following', gender: 'female', confidence: 0.9, reason: 'Mara is a conventionally feminine given name' },
  { id: 'demo-4', username: 'dawnledger', fullName: 'Jon Bell', relationship: 'following', gender: 'male', confidence: 0.88, reason: 'Jon is a conventionally masculine given name', isPrivate: true },
  { id: 'demo-5', username: 'elias.market', fullName: 'Elias Noor', relationship: 'following', gender: 'male', confidence: 0.91, reason: 'Elias is a conventionally masculine given name', isVerified: true },
  { id: 'demo-6', username: 'fieldnotes.studio', fullName: 'Nadia Reyes', relationship: 'mutual', gender: 'female', confidence: 0.95, reason: 'Nadia is a conventionally feminine given name' },
  { id: 'demo-7', username: 'glint.supply', fullName: 'Glint Supply Co.', relationship: 'following', gender: 'organization', confidence: 0.93, reason: 'Business account name with no personal given name' },
  { id: 'demo-8', username: 'harbor.sequence', fullName: 'Ivy Chen', relationship: 'following', gender: 'female', confidence: 0.92, reason: 'Ivy is a conventionally feminine given name', isPrivate: true },
  { id: 'demo-9', username: 'inkline.daily', fullName: 'Sofia Grant', relationship: 'mutual', gender: 'female', confidence: 0.96, reason: 'Sofia is a conventionally feminine given name' },
  { id: 'demo-10', username: 'juniper.signal', fullName: 'Cal Reed', relationship: 'following', gender: 'male', confidence: 0.72, reason: 'Cal reads more conventionally masculine', isVerified: true },
  { id: 'demo-11', username: 'keystone.labs', fullName: 'Mina Torres', relationship: 'follower', gender: 'female', confidence: 0.91, reason: 'Mina is a conventionally feminine given name' },
  { id: 'demo-12', username: 'lowlight.club', fullName: 'Owen Voss', relationship: 'following', gender: 'male', confidence: 0.9, reason: 'Owen is a conventionally masculine given name', isPrivate: true },
  { id: 'demo-13', username: 'maple.thread', fullName: 'Priya Shah', relationship: 'follower', gender: 'female', confidence: 0.97, reason: 'Priya is a conventionally feminine given name' },
  { id: 'demo-14', username: 'nightform', fullName: 'Alex Mercer', relationship: 'following', gender: 'ambiguous', confidence: 0.45, reason: 'Alex is used across genders; cannot infer reliably' },
  { id: 'demo-15', username: 'olive.press', fullName: 'Hannah Liu', relationship: 'mutual', gender: 'female', confidence: 0.94, reason: 'Hannah is a conventionally feminine given name' },
  { id: 'demo-16', username: 'pine.and.ink', fullName: 'Jules Marchand', relationship: 'following', gender: 'ambiguous', confidence: 0.4, reason: 'Jules is used across genders' },
  { id: 'demo-17', username: 'quietmornings', fullName: 'Rosa Delgado', relationship: 'follower', gender: 'female', confidence: 0.93, reason: 'Rosa is a conventionally feminine given name', noPicture: true },
  { id: 'demo-18', username: 'relay.studio', fullName: 'Sam Okafor', relationship: 'following', gender: 'ambiguous', confidence: 0.35, reason: 'Sam is used across genders' },
  { id: 'demo-19', username: 'salt.and.cedar', fullName: 'Grace Whitfield', relationship: 'following', gender: 'female', confidence: 0.98, reason: 'Grace is a conventionally feminine given name' },
  { id: 'demo-20', username: 'terra.works', fullName: 'Terra Works', relationship: 'following', gender: 'organization', confidence: 0.96, reason: 'Business account name with no personal given name', isVerified: true },
  { id: 'demo-21', username: 'understory', fullName: 'Yuki Tanaka', relationship: 'mutual', gender: 'female', confidence: 0.55, reason: 'Yuki is commonly feminine, but the name is ambiguous enough to fall below the confidence threshold' },
  { id: 'demo-22', username: 'velvet.orbit', fullName: 'Camila Duarte', relationship: 'following', gender: 'female', confidence: 0.96, reason: 'Camila is a conventionally feminine given name', isVerified: true },
  { id: 'demo-23', username: 'wintermute', fullName: 'Noor Haddad', relationship: 'follower', gender: 'female', confidence: 0.85, reason: 'Noor is commonly feminine in this context' },
  { id: 'demo-24', username: 'xenon.drift', fullName: 'Theo Park', relationship: 'following', gender: 'male', confidence: 0.87, reason: 'Theo is commonly masculine in this context' },
  { id: 'demo-25', username: 'yucca.bloom', fullName: 'Imogen Hart', relationship: 'following', gender: 'female', confidence: 0.95, reason: 'Imogen is a conventionally feminine given name' },
  { id: 'demo-26', username: 'zero.point', fullName: 'Riley Adams', relationship: 'follower', gender: 'ambiguous', confidence: 0.42, reason: 'Riley is used across genders' },
  { id: 'demo-27', username: 'nightly.bot', fullName: 'Nightly Bot', relationship: 'following', gender: 'machine', confidence: 0.97, reason: 'Automated bot account name with no person behind it' },
  { id: 'demo-28', username: 'field.notes.corp', fullName: 'Field Notes Corp.', relationship: 'mutual', gender: 'organization', confidence: 0.95, reason: 'Corporate account name with no personal given name', isVerified: true },
];

// Instagram's well-known "no profile picture" asset id, inlined as an offline
// data URI so the preview (and its tests) never touch the network.
const NO_PICTURE_URL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><desc>44884218_345707102882519_2446069589734326272_n</desc><circle cx="48" cy="48" r="48" fill="#1f2937"/></svg>',
  );

function userFromSpec(spec: DemoSpec): UserNode {
  return {
    id: spec.id,
    username: spec.username,
    full_name: spec.fullName,
    profile_pic_url: spec.noPicture === true ? NO_PICTURE_URL : avatar(spec.fullName, '#334155'),
    is_private: spec.isPrivate === true,
    is_verified: spec.isVerified === true,
    followed_by_viewer: spec.relationship !== 'follower',
    follows_viewer: spec.relationship !== 'following',
    requested_by_viewer: false,
    reel: {
      id: spec.id,
      expiring_at: 0,
      has_pride_media: false,
      latest_reel_media: 0,
      seen: null,
      owner: {
        __typename: Typename.GraphUser,
        id: spec.id,
        profile_pic_url: avatar(spec.fullName, '#334155'),
        username: spec.username,
      },
    },
  };
}

function guessForSpec(spec: DemoSpec): GenderGuess {
  return {
    gender: spec.gender,
    confidence: spec.confidence,
    reason: spec.reason,
    source: 'demo',
    model: DEMO_CLASSIFIER_VERSION,
    classifiedAt: DEMO_TIMESTAMP,
  };
}

/** Deterministic demo candidates; never fetched from Instagram. */
export function createDemoCandidates(): readonly AuditCandidate[] {
  return DEMO_SPECS.map(spec => ({
    user: userFromSpec(spec),
    relationship: spec.relationship,
    gender: guessForSpec(spec),
  }));
}

/** Accounts the demo pre-loads into the whitelist to demonstrate protection. */
export function createDemoWhitelist(candidates: readonly AuditCandidate[] = createDemoCandidates()): readonly UserNode[] {
  const protectedUsernames = new Set(['inkline.daily', 'velvet.orbit']);
  return candidates.filter(candidate => protectedUsernames.has(candidate.user.username)).map(candidate => candidate.user);
}

export interface DemoDataset {
  readonly candidates: readonly AuditCandidate[];
  readonly whitelistedResults: readonly UserNode[];
}

export function createDemoDataset(): DemoDataset {
  const candidates = createDemoCandidates();
  return { candidates, whitelistedResults: createDemoWhitelist(candidates) };
}
